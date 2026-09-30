import { randomUUID } from "node:crypto";

import {
  readAppleMusicSourceStatus,
  resolveAppleMusicImportsRoot,
} from "./apple-library-source-status.mjs";
import {
  listAgentCapabilityDescriptors,
  listCapabilities,
} from "./capability-catalog.mjs";
import { recoverArtistReleasesWithCrossCatalogIdentity } from "../integrations/cross-catalog-artist-identity.mjs";
import { normalizeMemoryContent } from "../memory/local-memory-store.mjs";

const minimumNodeVersion = [22, 19, 0];

function spotifyResolutionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Only the host's current user message can grant a quick edit. Model tool
// arguments and Spotify metadata never supply authorization. Exact ordinary
// commands and quoted names work; ambiguity uses the existing preview path.
function explicitQuickPlaylistIntent(text) {
  if (typeof text !== "string" || text.length > 1000 || /[\n\r\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text)) return null;
  const value = text.trim().replace(/[“”「」]/gu, '"');
  const prefix = "(?:(?:please|can you|could you)\\s+)?";
  let match = value.match(new RegExp(`^${prefix}rename(?: (?:the|my))? (?:private |Spotify )?playlist "([^"\\n]{1,200})" to "([^"\\n]{1,100})"[.!?]?$`, "iu")) ??
    value.match(/^(?:请)?(?:把|将)?歌单\s*"([^"]{1,200})"\s*(?:重命名|改名|更名)为\s*"([^"]{1,100})"[。！]?$/u);
  if (match) return { action: "rename", playlistName: match[1], name: match[2] };
  if (!/[";!?]|\b(?:and|then|also)\b/iu.test(value)) {
    const plainRename = value.match(new RegExp(`^${prefix}rename(?: (?:the|my))? (?:private |Spotify )?playlist (.{1,200}?) to (.{1,100}?)[.]?$`, "iu"));
    if (plainRename && (value.match(/\s+to\s+/giu) ?? []).length === 1) return { action: "rename", playlistName: plainRename[1].trim(), name: plainRename[2].trim() };
    const plainRemove = value.match(new RegExp(`^${prefix}remove (.{1,256}?) from(?: (?:the|my))? (?:private |Spotify )?playlist (.{1,200}?)[.]?$`, "iu"));
    if (plainRemove && (value.match(/\s+from\s+/giu) ?? []).length === 1) return { action: "remove_track", title: plainRemove[1].trim(), playlistName: plainRemove[2].trim() };
  }
  match = value.match(new RegExp(`^${prefix}remove "([^"\\n]{1,256})"(?: by "([^"\\n]{1,256})")? from(?: (?:the|my))? (?:private |Spotify )?playlist "([^"\\n]{1,200})"[.!?]?$`, "iu"));
  if (match) return { action: "remove_track", title: match[1], artist: match[2], playlistName: match[3] };
  match = value.match(/^(?:请)?从歌单\s*"([^"]{1,200})"\s*中?(?:移除|删除)\s*"([^"]{1,256})"(?:\s*(?:歌手|作者)\s*"([^"]{1,256})")?[。！]?$/u);
  return match ? { action: "remove_track", playlistName: match[1], title: match[2], artist: match[3] } : null;
}

function spotifyPlaylistDetails({ name, description } = {}) {
  if (
    typeof name !== "string" ||
    name.trim().length < 1 ||
    Array.from(name).length > 100
  ) {
    throw spotifyResolutionError(
      "invalid_playlist_name",
      "The Spotify playlist name is invalid.",
    );
  }
  if (
    description !== undefined &&
    (typeof description !== "string" || Array.from(description).length > 200)
  ) {
    throw spotifyResolutionError(
      "invalid_playlist_description",
      "The Spotify playlist description is invalid.",
    );
  }
  return {
    name: name.trim(),
    ...(description !== undefined ? { description: description.trim() } : {}),
  };
}

const requiredDomainServiceMethods = Object.freeze([
  "searchLibrary",
  "getProfileSummary",
  "explainProfileEvidence",
  "buildPlaylistPlan",
  "getTrustedTracks",
  "registerRetainedPlaylistCandidateSet",
  "beginPrompt",
  "endPrompt",
  "resetCandidateSets",
]);

const requiredProfileServiceMethods = Object.freeze([
  "getProfileSummary",
  "explainProfileEvidence",
]);
const requiredPlaylistServiceMethods = Object.freeze([
  "buildPlaylistPlan",
  "getTrustedTracks",
  "registerRetainedPlaylistCandidateSet",
  "beginPrompt",
  "endPrompt",
  "resetCandidateSets",
]);

const requiredMusicCatalogMethods = Object.freeze([
  "findArtistReleases",
]);
const requiredMusicSimilarityMethods = Object.freeze([
  "discoverSimilarTracks",
]);

function versionAtLeast(actual, minimum) {
  const values = actual.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < minimum.length; index += 1) {
    const actualValue = values[index] ?? 0;
    if (actualValue > minimum[index]) return true;
    if (actualValue < minimum[index]) return false;
  }
  return true;
}

function normalizedArtistName(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").toLocaleLowerCase("und").trim()
    : "";
}

function exactArtistReleaseHint(searchResult, artistName) {
  const normalizedArtist = normalizedArtistName(artistName);
  if (!normalizedArtist || !Array.isArray(searchResult?.tracks)) {
    return undefined;
  }
  const match = searchResult.tracks.find(
    (track) =>
      normalizedArtistName(track.artist_credit) === normalizedArtist &&
      typeof track.release === "string" &&
      track.release.trim().length > 0,
  );
  return match?.release.trim();
}

export class MoondogApplication {
  constructor({
    importsRoot = resolveAppleMusicImportsRoot(),
    domainServices = null,
    domainServicesError = null,
    memoryStore = null,
    memoryRouteKey = "local:main",
    spotifyConnection = null,
    musicCatalog = null,
    musicSimilarity = null,
    artistIdentityResolver = null,
    webResearch = null,
  } = {}) {
    this.importsRoot = importsRoot;
    this.domainServices = domainServices;
    this.domainServicesError =
      typeof domainServicesError === "string" &&
      /^projection_[a-z0-9_]+$/u.test(domainServicesError)
        ? domainServicesError
        : null;
    this.memoryStore = memoryStore;
    this.memoryRouteKey = memoryRouteKey;
    this.memorySession = null;
    this.spotifyConnection = spotifyConnection;
    this.musicCatalog = musicCatalog;
    this.musicSimilarity = musicSimilarity;
    this.artistIdentityResolver = artistIdentityResolver;
    this.webResearch = webResearch;
    this.spotifyResolutions = new Map();
    this.spotifyReadSelections = new Map();
    this.pendingSpotifyRemoval = null;
    this.spotifyDeviceSelections = new Map();
    this.recentSimilarQueueUris = new Map();
    this.transientSpotifyContext = false;
    this.spotifyPlaylistTargets = new Map();
    this.spotifyPlaylistItems = new Map();
    this.spotifyPlaylistSnapshots = new Map();
    this.validatedPlaylistTrackRefs = null;
    this.pendingSpotifyPlaylist = null;
    this.pendingSpotifyPlaylistEdit = null;
    this.pendingPlaylistRevisionCandidateSet = null;
    this.promptDiscoverySources = [];
    this.promptProfileSeed = null;
    this.pendingPlaylistPromptTransaction = null;
  }

  domainServicesReady() {
    return (
      this.domainServices !== null &&
      requiredDomainServiceMethods.every(
        (method) => typeof this.domainServices[method] === "function",
      )
    );
  }

  profileServicesReady() {
    return (
      this.domainServices !== null &&
      requiredProfileServiceMethods.every(
        (method) => typeof this.domainServices[method] === "function",
      )
    );
  }

  playlistServicesReady() {
    return (
      this.domainServices !== null &&
      requiredPlaylistServiceMethods.every(
        (method) => typeof this.domainServices[method] === "function",
      ) &&
      (typeof this.domainServices.playlistReady !== "function" ||
        this.domainServices.playlistReady() === true)
    );
  }

  rediscoveryServicesReady() {
    return (
      this.playlistServicesReady() &&
      typeof this.domainServices.getRediscoveryCandidates === "function" &&
      typeof this.domainServices.rediscoveryReady === "function" &&
      this.domainServices.rediscoveryReady() === true
    );
  }

  historicalReturnServicesReady() {
    return (
      this.playlistServicesReady() &&
      typeof this.domainServices.getHistoricalReturnCandidates ===
        "function" &&
      typeof this.domainServices.historicalReturnReady === "function" &&
      this.domainServices.historicalReturnReady() === true
    );
  }

  timeCapsuleServicesReady() {
    return (
      this.playlistServicesReady() &&
      typeof this.domainServices.getTimeCapsuleCandidates === "function" &&
      typeof this.domainServices.timeCapsuleReady === "function" &&
      this.domainServices.timeCapsuleReady() === true
    );
  }

  backToBackServicesReady() {
    return (
      this.playlistServicesReady() &&
      typeof this.domainServices.getBackToBackCandidates === "function" &&
      typeof this.domainServices.backToBackReady === "function" &&
      this.domainServices.backToBackReady() === true
    );
  }

  requireDomainServices() {
    if (!this.domainServicesReady()) {
      throw new Error(
        "Moondog's library and profile projection is not ready. Rebuild the local projection first.",
      );
    }
    return this.domainServices;
  }

  requireProfileServices() {
    if (!this.profileServicesReady()) {
      throw new Error(
        "Moondog's profile projection is not ready. Import Spotify history or rebuild the local Apple projection first.",
      );
    }
    return this.domainServices;
  }

  requirePlaylistServices() {
    if (!this.playlistServicesReady()) {
      throw new Error("Moondog's trusted playlist-planning path is not ready.");
    }
    return this.domainServices;
  }

  requireRediscoveryServices() {
    if (!this.rediscoveryServicesReady()) {
      throw new Error(
        "Moondog's private listening-history rediscovery path is not ready.",
      );
    }
    return this.domainServices;
  }

  requireHistoricalReturnServices() {
    if (!this.historicalReturnServicesReady()) {
      throw new Error(
        "Moondog's private listening-history return path is not ready.",
      );
    }
    return this.domainServices;
  }

  requireTimeCapsuleServices() {
    if (!this.timeCapsuleServicesReady()) {
      throw new Error(
        "Moondog's private listening-history Time Machine path is not ready.",
      );
    }
    return this.domainServices;
  }

  requireBackToBackServices() {
    if (!this.backToBackServicesReady()) {
      throw new Error(
        "Moondog's private listening-history back-to-back path is not ready.",
      );
    }
    return this.domainServices;
  }

  musicCatalogReady() {
    return (
      this.musicCatalog !== null &&
      requiredMusicCatalogMethods.every(
        (method) => typeof this.musicCatalog[method] === "function",
      )
    );
  }

  requireMusicCatalog() {
    if (!this.musicCatalogReady()) {
      throw new Error("Moondog's external music catalog is not ready.");
    }
    return this.musicCatalog;
  }

  musicDiscoveryReady() {
    return (
      this.musicCatalogReady() &&
      this.profileServicesReady() &&
      this.playlistServicesReady() &&
      typeof this.musicCatalog.searchTracks === "function" &&
      typeof this.domainServices.registerExternalCandidateSet === "function"
    );
  }

  requireMusicDiscovery() {
    if (!this.musicDiscoveryReady()) {
      throw new Error(
        "Moondog's external music discovery path is not ready.",
      );
    }
    return {
      catalog: this.musicCatalog,
      domainServices: this.domainServices,
    };
  }

  musicSimilarityReady() {
    return (
      this.musicSimilarity !== null &&
      this.profileServicesReady() &&
      this.playlistServicesReady() &&
      requiredMusicSimilarityMethods.every(
        (method) => typeof this.musicSimilarity[method] === "function",
      ) &&
      typeof this.domainServices.registerExternalCandidateSet === "function"
    );
  }

  requireMusicSimilarity() {
    if (!this.musicSimilarityReady()) {
      throw new Error(
        "Moondog's open artist similarity path is not ready.",
      );
    }
    return {
      similarity: this.musicSimilarity,
      domainServices: this.domainServices,
    };
  }

  async sourceStatus() {
    const source = await readAppleMusicSourceStatus(this.importsRoot);
    if (source.latest && this.profileServicesReady()) {
      source.semantics.profile_materialization_ready = true;
    }
    return source;
  }

  async profileStatus() {
    if (
      this.profileServicesReady() &&
      typeof this.domainServices.profileStatus === "function"
    ) {
      return this.domainServices.profileStatus();
    }
    const source = await this.sourceStatus();
    const projectionInvalid =
      this.domainServicesError !== null &&
      this.domainServicesError !== "projection_not_built";
    return {
      state: projectionInvalid ? "invalid" : "not_materialized",
      source_state: source.state,
      evidence_records: 0,
      claims: 0,
      ...(this.domainServicesError
        ? { error: this.domainServicesError }
        : {}),
      reason:
        projectionInvalid
          ? "The local ProfileProjection is unavailable or invalid. Rebuild it from the verified Apple import batch before using library-aware tools."
          : "The verified Apple library snapshot is canonical input, but its disposable ProfileProjection has not been built yet. Run the local projection rebuild before using library-aware tools.",
      next_contracts: [
        "library_track_observation",
        "profile_evidence_v2",
        "sqlite_projection",
      ],
    };
  }

  memoryStatus() {
    if (this.memoryStore) {
      const status = this.memoryStore.status();
      const reflection = this.memoryStore.reflectionStatus();
      return {
        state: status.state,
        conversation_transcript: "local_sqlite",
        long_term_memory: "explicit_revisable_claims",
        music_profile_is_separate: true,
        sessions: status.sessions,
        turns: status.turns,
        episodes: status.episodes,
        active_memories: status.active_memories,
        reflection,
        policy:
          "Completed dialogue becomes short-term episodes. The background Memory Agent may promote high-confidence explicit general assertions into durable claims. Inferred claims and music taste remain reviewable candidates for the long-term memory and Profile pipelines.",
      };
    }
    return {
      state: "not_persistent",
      conversation_transcript: "process_local_only",
      long_term_memory: "not_implemented",
      music_profile_is_separate: true,
      policy:
        "A conversation summary does not become long-term memory without an explicit user assertion or confirmation.",
    };
  }

  memorySummary({ query, limit = 12 } = {}) {
    const status = this.memoryStatus();
    if (!this.memoryStore) {
      return {
        ...status,
        memories: [],
        recent_episodes: [],
        recent_sessions: [],
      };
    }
    const session = this.ensureMemorySession();
    return {
      ...status,
      memories: this.memoryStore.listMemories({ query, limit }),
      recent_episodes: this.memoryStore.recentEpisodes({
        query,
        limit,
      }),
      recent_sessions: this.memoryStore.recentSessions({
        excludeSessionId: session.session_id,
        limit: 2,
        turnsPerSession: 4,
      }),
    };
  }

  memoryContext(query) {
    if (!this.memoryStore) {
      return {
        state: "not_persistent",
        durable_memories: [],
        relevant_memories: [],
        recent_episodes: [],
        recent_sessions: [],
      };
    }
    const session = this.ensureMemorySession();
    return {
      state: "ready",
      ...this.memoryStore.context({
        query,
        currentSessionId: session.session_id,
      }),
    };
  }

  rememberMemory({ text, kind, horizon, origin = "explicit_user" }) {
    if (!this.memoryStore) throw new Error("Persistent memory is unavailable");
    const session = this.ensureMemorySession();
    return this.memoryStore.remember({
      text,
      kind,
      horizon,
      origin,
      sourceSessionId: session.session_id,
    });
  }

  pendingMemoryReflection(options) {
    if (!this.memoryStore) throw new Error("Persistent memory is unavailable");
    return this.memoryStore.pendingReflectionEpisodes(options);
  }

  beginMemoryReflection(options) {
    if (!this.memoryStore) throw new Error("Persistent memory is unavailable");
    return this.memoryStore.beginReflection(options);
  }

  completeMemoryReflection(options) {
    if (!this.memoryStore) throw new Error("Persistent memory is unavailable");
    return this.memoryStore.completeReflection(options);
  }

  failMemoryReflection(runId, leaseToken, errorCode) {
    if (!this.memoryStore) throw new Error("Persistent memory is unavailable");
    return this.memoryStore.failReflection(runId, leaseToken, errorCode);
  }

  memoryReflectionStatus() {
    if (!this.memoryStore) {
      return {
        state: "unavailable",
        pending_episodes: 0,
        candidate_episodes: 0,
        last_run: null,
      };
    }
    return this.memoryStore.reflectionStatus();
  }

  forgetMemory(memoryId) {
    if (!this.memoryStore) throw new Error("Persistent memory is unavailable");
    const session = this.ensureMemorySession();
    return this.memoryStore.forget(memoryId, {
      sourceSessionId: session.session_id,
    });
  }

  prepareRememberMemory({ text, kind, horizon, origin }) {
    if (!this.memoryStore) throw new Error("Persistent memory is unavailable");
    const session = this.ensureMemorySession();
    return this.memoryStore.prepareRemember({
      text,
      kind,
      horizon,
      origin,
      sourceSessionId: session.session_id,
    });
  }

  prepareForgetMemory(memoryId) {
    if (!this.memoryStore) throw new Error("Persistent memory is unavailable");
    const session = this.ensureMemorySession();
    return this.memoryStore.prepareForget(memoryId, {
      sourceSessionId: session.session_id,
    });
  }

  commitCompletedPrompt(user, assistant, memoryMutations = []) {
    // Follow-up replies can paraphrase live results from the process-local
    // conversation. Keep that conversation out of generic durable memory.
    if (this.transientSpotifyContext) return this.commitTransientPrompt(memoryMutations, user);
    if (!this.memoryStore) return { recorded: false, memory_results: [] };
    const session = this.ensureMemorySession();
    return this.memoryStore.commitCompletedPrompt(session.session_id, {
      user,
      assistant,
      memoryMutations,
    });
  }

  recordCompletedTurn(user, assistant) {
    return this.commitCompletedPrompt(user, assistant);
  }

  commitTransientPrompt(memoryMutations = [], user = "") {
    // Keep explicit user claims and retractions without recording live dialogue
    // or feeding it to reflection. Store the verified quote, never its model
    // paraphrase: that could smuggle provider content into an otherwise valid quote.
    const eligible = memoryMutations.filter((mutation) => mutation.type === "forget" ||
      (mutation.type === "remember" && typeof mutation.sourceUserText === "string" &&
        mutation.sourceUserText.length > 0 && user.includes(mutation.sourceUserText) &&
        normalizeMemoryContent(mutation.sourceUserText) === mutation.content));
    return { recorded: false,
      memory_results: this.memoryStore?.commitMemoryMutations(eligible) ?? [],
      discarded_memories: memoryMutations.length - eligible.length };
  }

  #clearConversationState() {
    this.resetSpotifyReadContext();
    this.pendingSpotifyPlaylist = null;
    this.pendingSpotifyPlaylistEdit = null;
    this.pendingPlaylistRevisionCandidateSet = null;
    this.promptDiscoverySources = [];
    this.pendingPlaylistPromptTransaction = null;
    this.resetSpotifyResolutions();
    this.resetSpotifyPlaylistInspection();
    this.domainServices?.resetCandidateSets?.();
  }

  startNewSession(reason = "new_session") {
    this.memorySession = this.memoryStore
      ? this.memoryStore.rotateSession(this.memoryRouteKey, reason)
      : null;
    this.#clearConversationState();
    return structuredClone(this.memorySession);
  }

  listSavedSessions({ limit = 200 } = {}) {
    if (!this.memoryStore) return [];
    return this.memoryStore.listSessions({
      routeKey: this.memoryRouteKey,
      limit,
    });
  }

  resumeSession(sessionId) {
    if (!this.memoryStore) throw new Error("Persistent memory is unavailable");
    this.memorySession = this.memoryStore.resumeSession(sessionId, {
      routeKey: this.memoryRouteKey,
    });
    this.#clearConversationState();
    return structuredClone(this.memorySession);
  }

  ensureMemorySession() {
    if (!this.memoryStore) return null;
    this.memorySession ??= this.memoryStore.resumeOrStartSession(
      this.memoryRouteKey,
    );
    return this.memorySession;
  }

  currentSessionTurns({ limit = 40 } = {}) {
    if (!this.memoryStore) return [];
    const session = this.ensureMemorySession();
    return this.memoryStore.readSessionTurns(session.session_id, { limit });
  }

  setSpotifyConnection(connection) {
    this.resetSpotifyReadContext();
    this.spotifyConnection = connection;
    return this.spotifyStatus();
  }

  spotifyReady() {
    return Boolean(
      this.spotifyConnection?.ready?.() && this.spotifyConnection?.service,
    );
  }

  spotifyStatus() {
    return this.spotifyConnection?.publicStatus?.() ?? {
      provider: "spotify",
      state: "not_configured",
      reason: "client_id_required",
      authentication: "not_configured",
      client_id_configured: false,
      external_effects: "disabled",
    };
  }

  requireSpotifyService() {
    if (!this.spotifyReady()) {
      throw new Error(
        "Spotify control is not ready. Configure a client ID and run moondog spotify login first.",
      );
    }
    return this.spotifyConnection.service;
  }

  resetSpotifyReadContext() {
    this.spotifyReadSelections.clear();
    this.pendingSpotifyRemoval = null;
    this.spotifyDeviceSelections.clear();
    this.recentSimilarQueueUris.clear();
    this.transientSpotifyContext = false;
  }

  spotifyReadContext() {
    return [...this.spotifyReadSelections.entries(), ...(this.spotifyDeviceSelections.size ? [["devices", [...this.spotifyDeviceSelections.values()].map(({ id: _id, ...device }) => device)]] : [])].map(([source, items]) => ({
      source,
      items: items.map(({ uri: _uri, ...item }) => structuredClone(item)),
    }));
  }

  #registerSpotifyReadItems(source, values) {
    const items = values.slice(0, 50).filter((item) => item && typeof item === "object").map((item) => {
      const result = { type: ["track", "episode", "album", "artist", "playlist", "show", "ad", "unknown"].includes(item.type) ? item.type : "track" };
      const text = (value) => typeof value === "string" ? Array.from(value
        .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, " ")
        .replace(/\s+/gu, " ").trim()).slice(0, 256).join("") : "";
      for (const field of ["name", "album", "publisher", "release_date", "added_at", "played_at"]) if (text(item[field])) result[field] = text(item[field]);
      result.artists = (Array.isArray(item.artists) ? item.artists : []).slice(0, 5).map(text).filter(Boolean);
      if (Number.isInteger(item.duration_ms) && item.duration_ms >= 0 && item.duration_ms <= 86_400_000) result.duration_ms = item.duration_ms;
      if (Number.isInteger(item.popularity) && item.popularity >= 0 && item.popularity <= 100) result.popularity = item.popularity;
      if (typeof item.explicit === "boolean") result.explicit = item.explicit;
      if (["track", "episode", "album", "artist", "playlist", "show"].includes(result.type) && typeof item.uri === "string" &&
          new RegExp(`^spotify:${result.type}:[A-Za-z0-9]{1,128}$`, "u").test(item.uri) && item.is_local !== true) {
        result.item_ref_id = randomUUID();
        if (result.type === "track") result.track_ref_id = result.item_ref_id;
        result.uri = item.uri;
      }
      return result;
    });
    // A fixed set of bounded read surfaces survives turns, never session reset.
    this.spotifyReadSelections.set(source, items);
    return items.map(({ uri: _uri, ...item }) => structuredClone(item));
  }

  async spotifyNowPlaying({ signal } = {}) {
    this.transientSpotifyContext = true;
    const player = await this.requireSpotifyService().currentPlayer({ signal });
    signal?.throwIfAborted();
    const items = this.#registerSpotifyReadItems("now_playing", player.item ? [player.item] : []);
    return { ...player, item: items[0] ?? null };
  }

  async spotifyPlayerStatus({ signal } = {}) {
    const player = await this.spotifyNowPlaying({ signal });
    if (player.state !== "available") {
      return { provider: "spotify", state: "inactive" };
    }
    return {
      ...player,
      provider: "spotify",
      state: "available",
      is_playing: player.is_playing === true,
      shuffle_state: player.shuffle_state === true,
      repeat_state: player.repeat_state,
      currently_playing_type: player.currently_playing_type,
      active_device: Boolean(player.device?.is_active),
      restricted_device: player.device?.is_restricted === true,
      item_available: Boolean(player.item),
    };
  }

  spotifyControl({ action, ...parameters }, { signal } = {}) {
    signal?.throwIfAborted();
    const service = this.requireSpotifyService();
    if (parameters.contextRefId !== undefined) {
      if (action !== "resume" || parameters.contextUri !== undefined || parameters.trackRefs !== undefined || parameters.uris !== undefined) {
        throw spotifyResolutionError("spotify_playback_source_conflict", "Choose one playback source.");
      }
      const { contextRefId, ...rest } = parameters;
      parameters = { ...rest, contextUri: this.requireSpotifyReadItem(contextRefId, ["album", "artist", "playlist"]).uri };
    }
    if (action === "resume" && Array.isArray(parameters.trackRefs)) {
      const { trackRefs, ...playbackParameters } = parameters;
      const uris = this.requireSpotifyTrackUris(trackRefs);
      return service.resume({
        ...playbackParameters,
        uris,
      }, { signal });
    }
    switch (action) {
      case "resume":
        return service.resume(parameters, { signal });
      case "pause":
        return service.pause(parameters, { signal });
      case "next":
        return service.next(parameters, { signal });
      case "previous":
        return service.previous(parameters, { signal });
      case "volume":
        return service.setVolume(parameters, { signal });
      case "seek":
        return service.seek(parameters, { signal });
      case "shuffle":
        return service.setShuffle(parameters, { signal });
      case "repeat":
        return service.setRepeat(parameters, { signal });
      default:
        throw new Error("Unsupported Spotify player action.");
    }
  }

  async spotifyTopItems(input, { signal } = {}) {
    signal?.throwIfAborted();
    this.requireSpotifyScopes(["user-top-read"], "spotify_top_scope_missing");
    this.transientSpotifyContext = true;
    const result = await this.requireSpotifyService().topItems(input, { signal });
    signal?.throwIfAborted();
    const raw = Array.isArray(result.items) ? result.items.slice(0, 10) : [];
    const items = result.type === "tracks" ? this.#registerSpotifyReadItems("top_tracks", raw) :
      raw.map((item) => ({ type: "artist", name: typeof item.name === "string" ? item.name.slice(0, 256) : "" }));
    return { ...result, items: items.map((item, index) => ({ ...item,
      affinity_rank: Number.isInteger(raw[index]?.affinity_rank) ? raw[index].affinity_rank : index + 1 })) };
  }

  async spotifyBrowseLibrary(input, { signal } = {}) {
    this.requireSpotifyScopes([input?.type === "artists" ? "user-follow-read" : input?.type === "playlists" ? "playlist-read-private" : "user-library-read"]);
    this.transientSpotifyContext = true;
    const result = await this.requireSpotifyService().libraryBrowse(input, { signal });
    signal?.throwIfAborted();
    return { ...result, items: this.#registerSpotifyReadItems("library", result.items ?? []) };
  }

  async spotifyRecentHistory(input, { signal } = {}) {
    this.requireSpotifyScopes(["user-read-recently-played"]);
    this.transientSpotifyContext = true;
    const result = await this.requireSpotifyService().recentActivity(input, { signal });
    signal?.throwIfAborted();
    const items = (result.items ?? []).slice(0, 50).map(({ track, played_at }) => ({ ...track, type: "track", played_at,
      ...(/^[A-Za-z0-9]{1,128}$/u.test(track?.id ?? "") ? { uri: `spotify:track:${track.id}` } : {}) }));
    return { ...result, items: this.#registerSpotifyReadItems("history", items) };
  }

  requireSpotifyReadItem(ref, types) {
    const item = [...this.spotifyReadSelections.values()].flat().find((entry) => entry.item_ref_id === ref);
    if (!item?.uri || !types.includes(item.type)) throw spotifyResolutionError("spotify_item_not_available", "That item reference is unavailable or unsuitable for this action. Read or search again.");
    return item;
  }

  async spotifySearchTracks(input, { signal } = {}) {
    this.transientSpotifyContext = true;
    const result = await this.requireSpotifyService().searchTracks(input, { signal });
    signal?.throwIfAborted();
    const raw = Array.isArray(result.items) ? result.items : [];
    return { ...result, items: this.#registerSpotifyReadItems("search", raw.slice(0, 10)),
      truncated: result.truncated === true || raw.length > 10 };
  }

  async spotifyCatalogChildren({ itemRefId, limit, offset } = {}, { signal } = {}) {
    const item = this.requireSpotifyReadItem(itemRefId, ["album", "show"]);
    this.transientSpotifyContext = true;
    const result = await this.requireSpotifyService().catalogChildren({ type: item.type, id: item.uri.split(":")[2], limit, offset }, { signal });
    signal?.throwIfAborted();
    return { ...result, items: this.#registerSpotifyReadItems("catalog_children", result.items ?? []) };
  }

  spotifySaveLibraryItems({ itemRefs } = {}, { signal } = {}) {
    if (!Array.isArray(itemRefs) || itemRefs.length < 1 || itemRefs.length > 12) throw spotifyResolutionError("spotify_library_selection_invalid", "Choose from 1 to 12 returned items.");
    const items = itemRefs.map((ref) => this.requireSpotifyReadItem(ref, ["track", "album", "episode", "show", "playlist"]));
    this.requireSpotifyWriteScopes([...new Set(items.map((item) => item.type === "playlist" ? "playlist-modify-public" : "user-library-modify"))]);
    return this.requireSpotifyService().saveItems({ uris: items.map((item) => item.uri) }, { signal });
  }

  async spotifyQueueStatus({ signal } = {}) {
    this.transientSpotifyContext = true;
    const result = await this.requireSpotifyService().queue({ signal });
    signal?.throwIfAborted();
    const raw = Array.isArray(result.queue) ? result.queue : [];
    const current = result.currently_playing;
    const items = this.#registerSpotifyReadItems("queue", [...(current ? [current] : []), ...raw.slice(0, 10)]);
    return { ...result, currently_playing: current ? items.shift() : null, queue: items,
      queue_count: Math.min(50, raw.length), truncated: result.truncated === true || raw.length > 10 };
  }

  spotifyAddToQueue(input, { signal } = {}) {
    signal?.throwIfAborted();
    if (input?.itemRefId !== undefined) {
      if (input.trackRefId !== undefined || input.uri !== undefined) throw spotifyResolutionError("spotify_queue_selection_conflict", "Choose one queue item.");
      const item = this.requireSpotifyReadItem(input.itemRefId, ["track", "episode"]);
      return this.requireSpotifyService().addToQueue({ uri: item.uri, ...(input.deviceId ? { deviceId: input.deviceId } : {}) }, { signal });
    }
    if (input?.trackRefId !== undefined) {
      const resolution = this.requireSpotifyResolution(input.trackRefId);
      return this.requireSpotifyService().addToQueue({
        uri: resolution.uri,
        ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      }, { signal });
    }
    return this.requireSpotifyService().addToQueue(input, { signal });
  }

  async spotifyQueueSimilar({ count = 5 } = {}, { signal } = {}) {
    signal?.throwIfAborted();
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      throw spotifyResolutionError("invalid_similar_queue_count", "The similar queue count must be an integer from 1 to 10.");
    }
    if (this.pendingPlaylistPromptTransaction?.similarQueueAttempted) {
      throw spotifyResolutionError("spotify_similar_queue_already_attempted", "Similar queue was already attempted for this request. Check its receipt before starting another request.");
    }
    if (this.pendingPlaylistPromptTransaction) this.pendingPlaylistPromptTransaction.similarQueueAttempted = true;
    this.transientSpotifyContext = true;
    const service = this.requireSpotifyService();
    const player = await service.currentPlayer({ signal });
    signal?.throwIfAborted();
    const item = player?.state === "available" ? player.item : null;
    const seedArtist = item?.type === "track" && Array.isArray(item.artists) ? item.artists[0] : null;
    const empty = (state) => ({ provider: "spotify", ok: true, effect: "write_external", action: "queue.similar",
      state, requested: count, queued_count: 0, queued: [], unmatched: [], not_added: [] });
    if (typeof seedArtist !== "string" || !seedArtist.trim()) return empty("no_playback");
    this.requireSpotifyScopes(["user-read-private", "user-read-playback-state"]);
    this.requireSpotifyWriteScopes(["user-modify-playback-state"]);
    const { similarity, domainServices } = this.requireMusicSimilarity();
    // Spotify's artists array already separates artists. A band's punctuation
    // (for example an ampersand) is part of its identity, not another artist.
    const discovered = await similarity.discoverSimilarTracks({ artistName: seedArtist, mode: "medium", limit: 12 }, { signal });
    signal?.throwIfAborted();
    if (discovered.state !== "resolved" || discovered.tracks.length === 0) return empty("no_candidates");
    const registered = domainServices.registerExternalCandidateSet({ tracks: discovered.tracks, source: discovered.source });
    if (registered.result_count === 0) return empty("no_candidates");
    const tracks = domainServices.getTrustedTracks(registered.tracks.map((track) => track.track_ref_id));
    const resolution = await this.requireSpotifyResolver().resolve(tracks, { signal });
    signal?.throwIfAborted();
    // Read immediately before the first write. Failure to inspect the queue
    // stops the operation instead of silently abandoning deduplication.
    const observed = await service.queue({ signal });
    signal?.throwIfAborted();
    const seenUris = new Set([item.uri, observed.currently_playing?.uri, ...(observed.queue ?? []).map((track) => track.uri)].filter(Boolean));
    const now = Date.now();
    for (const [uri, acceptedAt] of this.recentSimilarQueueUris) {
      if (now - acceptedAt > 15 * 60_000) this.recentSimilarQueueUris.delete(uri);
      else seenUris.add(uri);
    }
    const resolvedByRef = new Map((resolution.resolutions ?? [])
      .filter((entry) => entry.status === "resolved" && /^spotify:track:[A-Za-z0-9]{1,128}$/u.test(entry.spotify?.uri ?? ""))
      .map((entry) => [entry.track_ref_id, entry.spotify.uri]));
    const receipt = await this.#queueSpotifyTracks(tracks, resolvedByRef, { signal, seenUris, limit: count, domainServices });
    this.recordPromptDiscoverySource(registered.source);
    return { ...receipt, action: "queue.similar", requested: count, queued_count: receipt.queued.length,
      seed_artist: seedArtist, queue_observation_truncated: observed.truncated === true };
  }

  async spotifyDevices({ signal } = {}) {
    this.transientSpotifyContext = true;
    const result = await this.requireSpotifyService().devices({ signal });
    signal?.throwIfAborted();
    this.spotifyDeviceSelections.clear();
    const devices = (result.devices ?? []).slice(0, 20).map((device) => {
      const ref = randomUUID();
      this.spotifyDeviceSelections.set(ref, { ...device, device_ref_id: ref });
      const { id: _id, ...visible } = this.spotifyDeviceSelections.get(ref);
      return visible;
    });
    return { ...result, devices };
  }

  async spotifyDeviceTarget(input = {}, { signal, forVolume = false } = {}) {
    const { deviceId, deviceName, deviceRefId } = input;
    if ([deviceId, deviceName, deviceRefId].filter((v) => v !== undefined).length > 1) throw spotifyResolutionError("conflicting_device_target", "Choose one device target.");
    let id = deviceId;
    if (deviceRefId !== undefined) {
      id = this.spotifyDeviceSelections.get(deviceRefId)?.id;
      if (!id) throw spotifyResolutionError("spotify_device_reference_expired", "That device selection expired. List devices again.");
    }
    if (id === undefined && deviceName === undefined && !forVolume) return {};
    this.transientSpotifyContext = true;
    const device = await this.requireSpotifyService().resolveDevice({ deviceId: id, deviceName, forVolume }, { signal });
    signal?.throwIfAborted();
    return { deviceId: device.id };
  }

  async spotifyTransfer(input, { signal } = {}) {
    signal?.throwIfAborted();
    this.transientSpotifyContext = true;
    if (input.deviceRefId !== undefined) {
      const device = await this.spotifyDeviceTarget(input, { signal });
      return this.requireSpotifyService().transfer({ ...device, play: input.play }, { signal });
    }
    return this.requireSpotifyService().transfer(input, { signal });
  }

  requireSpotifyResolver() {
    const connection = this.spotifyConnection;
    if (!this.spotifyReady() || !connection?.resolver) {
      throw spotifyResolutionError(
        "spotify_resolver_unavailable",
        "Spotify catalog resolution is not ready. Configure a client ID and run moondog spotify login first.",
      );
    }
    return connection.resolver;
  }

  requireSpotifyScopes(requiredScopes, code = "spotify_scopes_missing") {
    const connection = this.spotifyConnection;
    const unavailable = new Set(connection?.missingScopes?.() ?? []);
    const missing = requiredScopes.filter((scope) => unavailable.has(scope));
    if (missing.length > 0) {
      throw spotifyResolutionError(
        code,
        `Spotify authorization is missing scopes: ${missing.join(", ")}. Run moondog spotify login again to grant them.`,
      );
    }
  }

  requireSpotifyWriteScopes(requiredScopes) {
    this.requireSpotifyScopes(requiredScopes, "spotify_write_scopes_missing");
  }

  resetSpotifyResolutions() {
    const invalidated = this.spotifyResolutions.size;
    this.spotifyResolutions.clear();
    this.validatedPlaylistTrackRefs = null;
    return { invalidated_spotify_resolutions: invalidated };
  }

  resetSpotifyPlaylistInspection() {
    const invalidated =
      this.spotifyPlaylistTargets.size +
      this.spotifyPlaylistItems.size +
      this.spotifyPlaylistSnapshots.size;
    this.spotifyPlaylistTargets.clear();
    this.spotifyPlaylistItems.clear();
    this.spotifyPlaylistSnapshots.clear();
    return { invalidated_spotify_playlist_refs: invalidated };
  }

  requireSpotifyPlaylistTarget(playlistRefId) {
    const target = this.spotifyPlaylistTargets.get(playlistRefId);
    if (!target) {
      throw spotifyResolutionError(
        "spotify_playlist_not_inspected",
        "The Spotify playlist reference is not active in this prompt. List and inspect the playlist first.",
      );
    }
    return target;
  }

  async spotifyListEditablePlaylists({ limit, offset } = {}, { signal } = {}) {
    signal?.throwIfAborted();
    this.requireSpotifyScopes(["user-read-private", "playlist-read-private"]);
    const result = await this.requireSpotifyService().editablePlaylists({
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    }, { signal });
    signal?.throwIfAborted();
    if (this.pendingPlaylistPromptTransaction) {
      this.pendingPlaylistPromptTransaction.quickPlaylistList = {
        complete: result.name_selection_complete === true && (offset ?? 0) === 0 && result.has_more !== true,
        ambiguousNames: result.ambiguous_names ?? [],
        ids: new Set((result.playlists ?? []).map((p) => p.playlist_id)),
      };
    }
    const playlists = [];
    for (const playlist of result.playlists ?? []) {
      const playlistRefId = randomUUID();
      this.spotifyPlaylistTargets.set(playlistRefId, {
        playlistId: playlist.playlist_id,
        name: playlist.name,
        trackCount: playlist.track_count,
      });
      playlists.push({
        playlist_ref_id: playlistRefId,
        name: playlist.name,
        track_count: playlist.track_count,
      });
    }
    return {
      provider: "spotify",
      playlists,
      excluded: structuredClone(result.excluded),
      has_more: result.has_more === true,
      next_offset: result.next_offset ?? null,
      expires_on: "prompt_end",
    };
  }

  async spotifyInspectPlaylist({ playlistRefId } = {}, { signal } = {}) {
    signal?.throwIfAborted();
    this.requireSpotifyScopes(["user-read-private", "playlist-read-private"]);
    const target = this.requireSpotifyPlaylistTarget(playlistRefId);
    const snapshot = await this.requireSpotifyService().playlistSnapshot({
      playlistId: target.playlistId,
    }, { signal });
    signal?.throwIfAborted();
    if (snapshot.playlist?.playlist_id !== target.playlistId) {
      throw spotifyResolutionError(
        "spotify_playlist_identity_changed",
        "Spotify returned a different playlist identity. List the playlist again before editing.",
      );
    }
    const items = snapshot.items.map((item, index) => {
      const playlistItemRefId = randomUUID();
      const safeItem = {
        playlist_item_ref_id: playlistItemRefId,
        position: index + 1,
        title: item.title,
        artists: [...item.artists],
        ...(item.album ? { album: item.album } : {}),
        ...(Number.isInteger(item.duration_ms)
          ? { duration_ms: item.duration_ms }
          : {}),
      };
      this.spotifyPlaylistItems.set(playlistItemRefId, {
        playlistRefId,
        uri: item.uri,
        position: index + 1,
        metadata: structuredClone(safeItem),
      });
      return safeItem;
    });
    this.spotifyPlaylistSnapshots.set(playlistRefId, {
      playlistId: target.playlistId,
      snapshotId: snapshot.playlist.snapshot_id,
      name: snapshot.playlist.name,
      items: items.map((item) => ({
        playlistItemRefId: item.playlist_item_ref_id,
        uri: this.spotifyPlaylistItems.get(item.playlist_item_ref_id).uri,
        position: item.position,
        metadata: structuredClone(item),
      })),
    });
    return {
      provider: "spotify",
      playlist: {
        playlist_ref_id: playlistRefId,
        name: snapshot.playlist.name,
        track_count: items.length,
        is_public: false,
      },
      items,
      expires_on: "prompt_end",
      edit_boundary:
        "Exact explicit rename or unique single-track removal may use quick edit. Other changes require preview and later confirmation.",
    };
  }

  requireSpotifyResolution(trackRefId) {
    const resolution = this.spotifyResolutions.get(trackRefId) ??
      [...this.spotifyReadSelections.values()].flat().find((item) => item.track_ref_id === trackRefId && item.uri);
    if (!resolution) {
      throw spotifyResolutionError(
        "spotify_track_not_resolved",
        "This Spotify track reference is unavailable or expired. Read the selection again, or resolve a trusted catalog candidate first.",
      );
    }
    return resolution;
  }

  requireSpotifyTrackUris(trackRefIds) {
    if (
      !Array.isArray(trackRefIds) ||
      trackRefIds.length < 1 ||
      trackRefIds.length > 12
    ) {
      throw spotifyResolutionError(
        "invalid_spotify_track_refs",
        "Spotify track references are invalid.",
      );
    }
    const seen = new Set();
    const uris = [];
    for (const trackRefId of trackRefIds) {
      if (
        typeof trackRefId !== "string" ||
        trackRefId.length < 1 ||
        trackRefId.length > 128 ||
        seen.has(trackRefId)
      ) {
        throw spotifyResolutionError(
          "invalid_spotify_track_refs",
          "Spotify track references are invalid.",
        );
      }
      seen.add(trackRefId);
      uris.push(this.requireSpotifyResolution(trackRefId).uri);
    }
    return uris;
  }

  async spotifyResolveTracks({ trackRefs } = {}, { signal } = {}) {
    signal?.throwIfAborted();
    if (
      !Array.isArray(trackRefs) ||
      trackRefs.length < 1 ||
      trackRefs.length > 12 ||
      trackRefs.some(
        (trackRefId) =>
          typeof trackRefId !== "string" ||
          trackRefId.length < 1 ||
          trackRefId.length > 128,
      )
    ) {
      throw spotifyResolutionError(
        "invalid_spotify_track_refs",
        "Spotify resolution track references are invalid.",
      );
    }
    const readItems = [...this.spotifyReadSelections.values()].flat();
    const retained = trackRefs.map((ref) => readItems.find((item) => item.track_ref_id === ref && item.uri)).filter(Boolean);
    const unresolved = trackRefs.filter((ref) => !retained.some((item) => item.track_ref_id === ref));
    let result = { resolutions: [], resolved_count: 0, not_found_count: 0 };
    if (unresolved.length > 0) {
      this.requireSpotifyScopes(["user-read-private"]);
      const trustedTracks = this.requirePlaylistServices().getTrustedTracks(unresolved);
      result = await this.requireSpotifyResolver().resolve(trustedTracks, { signal });
    }
    signal?.throwIfAborted();
    result.resolved_count += retained.length;
    result.resolutions.push(...retained.map((item) => ({ track_ref_id: item.track_ref_id, status: "resolved" })));
    const resolutions = [];
    for (const resolution of result.resolutions) {
      if (resolution.status === "resolved" && resolution.spotify) {
        this.spotifyResolutions.set(resolution.track_ref_id, {
          track_id: resolution.spotify.track_id,
          uri: resolution.spotify.uri,
          ...(resolution.matched
            ? { matched: structuredClone(resolution.matched) }
            : {}),
        });
      }
      const modelFacing = {
        track_ref_id: resolution.track_ref_id,
        status: resolution.status,
      };
      if (resolution.match_quality) {
        modelFacing.match_quality = resolution.match_quality;
      }
      if (resolution.matched) modelFacing.matched = resolution.matched;
      resolutions.push(modelFacing);
    }
    return {
      provider: "spotify",
      requested: resolutions.length,
      resolved_count: result.resolved_count,
      not_found_count: result.not_found_count,
      resolutions,
      expires_on: "prompt_end",
    };
  }

  spotifyPlaylistPreviewMetadata(value, fallback = {}) {
    const title = value?.title ?? value?.name ?? fallback.title;
    const artists = Array.isArray(value?.artists)
      ? value.artists
      : typeof value?.artist_credit === "string"
        ? [value.artist_credit]
        : Array.isArray(fallback.artists)
          ? fallback.artists
          : [];
    if (
      typeof title !== "string" ||
      !title ||
      artists.length < 1 ||
      artists.some((artist) => typeof artist !== "string" || !artist)
    ) {
      throw spotifyResolutionError(
        "spotify_playlist_track_metadata_unavailable",
        "A resolved Spotify track is missing safe display metadata, so the edit cannot be previewed.",
      );
    }
    const album = value?.album ?? value?.release ?? fallback.album;
    const durationMs = value?.duration_ms ?? fallback.duration_ms;
    return {
      title,
      artists: [...artists],
      ...(typeof album === "string" && album ? { album } : {}),
      ...(Number.isInteger(durationMs) && durationMs >= 0
        ? { duration_ms: durationMs }
        : {}),
    };
  }

  async spotifyQuickEditPlaylist({ action, playlistRefId, playlistItemRefId } = {}, { signal } = {}) {
    signal?.throwIfAborted();
    const transaction = this.pendingPlaylistPromptTransaction;
    const intent = transaction?.quickEditIntent;
    const deny = (message) => { throw spotifyResolutionError("spotify_quick_edit_requires_preview", message); };
    if (!intent || intent.action !== action) deny('Quick edits require an exact current request, such as Rename playlist "Old" to "New" or Remove "Track" by "Artist" from playlist "Name". Otherwise preview first.');
    if (transaction.removalPreviewAttempted || transaction.removalAttempted || transaction.removalConfirmationRequested) deny("Finish the current library removal flow before requesting a playlist edit.");
    if (transaction.quickEditAttempted) deny("A quick playlist edit was already attempted in this turn. Inspect its result before another explicit request.");
    if (transaction.playlistEditPreviewAttempted) deny("A preview was already attempted in this turn. Finish that preview flow before another explicit edit request.");
    this.requireSpotifyScopes(["user-read-private", "playlist-read-private"]);
    this.requireSpotifyWriteScopes(["playlist-modify-private"]);
    const target = this.requireSpotifyPlaylistTarget(playlistRefId);
    const snapshot = this.spotifyPlaylistSnapshots.get(playlistRefId);
    const list = transaction.quickPlaylistList;
    const namedTargets = new Set([...this.spotifyPlaylistTargets.values()].filter((t) => t.name === intent.playlistName).map((t) => t.playlistId));
    if (!snapshot || !list?.complete || !list.ids.has(target.playlistId) || list.ambiguousNames.includes(intent.playlistName) ||
        namedTargets.size !== 1 || target.name !== intent.playlistName || snapshot.name !== intent.playlistName) {
      deny("The named playlist is not uniquely established by a complete bounded list and fresh inspection. Use the exact preview flow.");
    }
    let uri;
    if (action === "remove_track") {
      const selected = snapshot.items.find((i) => i.playlistItemRefId === playlistItemRefId);
      const matching = snapshot.items.filter((i) => i.metadata.title === intent.title &&
        (!intent.artist || i.metadata.artists.join(", ") === intent.artist));
      if (!selected || matching.length !== 1 || matching[0] !== selected || snapshot.items.filter((i) => i.uri === selected.uri).length !== 1) {
        deny("The exact track or occurrence is ambiguous. Preview the complete final order before removing it.");
      }
      uri = selected.uri;
    } else if (playlistItemRefId !== undefined) deny("Rename accepts only a playlist target.");
    transaction.quickEditAttempted = true;
    this.transientSpotifyContext = true;
    try {
      const receipt = await this.requireSpotifyService().quickEditPlaylist({ action, playlistId: target.playlistId,
        expectedSnapshotId: snapshot.snapshotId, expectedName: snapshot.name, expectedTrackCount: snapshot.items.length,
        ...(uri ? { uri } : { name: intent.name }) }, { signal });
      transaction.externalized = true;
      this.pendingSpotifyPlaylistEdit = null;
      this.pendingSpotifyRemoval = null;
      transaction.removalInvalidated = true;
      this.resetSpotifyPlaylistInspection();
      return receipt;
    } catch (error) {
      if (error?.outcomeUnknown === true) error.spotifyQuickTarget = snapshot.name;
      if (error?.outcomeUnknown === true || error?.code === "playlist_snapshot_changed") {
        this.pendingSpotifyPlaylistEdit = null;
        transaction.editInvalidated = true;
        this.pendingSpotifyRemoval = null;
        transaction.removalInvalidated = true;
        if (error?.outcomeUnknown === true) transaction.externalized = true;
        this.resetSpotifyPlaylistInspection();
      }
      throw error;
    }
  }

  spotifyRemovalStatus() {
    const draft = this.pendingSpotifyRemoval;
    return draft ? { state: "preview", type: draft.type ?? "playlist", name: draft.name, confirmation: draft.confirmation, confirmable: draft.confirmable } : { state: "none" };
  }

  async spotifyRemovePlaylist({ action, playlistRefId, itemRefId, libraryItem = false } = {}, { signal } = {}) {
    signal?.throwIfAborted();
    this.transientSpotifyContext = true;
    const transaction = this.pendingPlaylistPromptTransaction;
    if (!transaction || transaction.removalAttempted) throw spotifyResolutionError("spotify_removal_unavailable", "Start a new explicit request before another playlist removal.");
    const service = this.requireSpotifyService();
    if (action === "preview") {
      if (transaction.playlistEditPreviewAttempted || transaction.playlistEditAttempted || transaction.quickEditAttempted) {
        throw spotifyResolutionError("spotify_confirmation_flow_conflict", "Finish the current playlist edit flow before previewing library removal.");
      }
      transaction.removalPreviewAttempted = true;
      if ((playlistRefId === undefined) === (itemRefId === undefined)) throw spotifyResolutionError("spotify_removal_target_required", "Select one inspected playlist reference.");
      if (libraryItem && itemRefId !== undefined) {
        const item = this.requireSpotifyReadItem(itemRefId, ["track", "album", "episode", "show", "playlist"]);
        if (item.type !== "playlist") {
          const confirmation = `Confirm removal of ${item.type} ${JSON.stringify(item.name)} from my library`;
          this.pendingSpotifyRemoval = { type: item.type, uri: item.uri, name: item.name, confirmation, confirmable: false };
          this.pendingSpotifyPlaylistEdit = null;
          return { provider: "spotify", state: "preview", type: item.type, name: item.name, confirmation, effect: "Remove from your Spotify library; the catalog item remains available." };
        }
      }
      this.requireSpotifyScopes(["user-read-private", "playlist-read-private"]);
      const playlistId = playlistRefId !== undefined ? this.requireSpotifyPlaylistTarget(playlistRefId).playlistId :
        this.requireSpotifyReadItem(itemRefId, ["playlist"]).uri.split(":")[2];
      const target = await service.playlistRemovalTarget({ playlistId }, { signal });
      signal?.throwIfAborted();
      const confirmation = `Confirm removal of playlist ${JSON.stringify(target.name)} from my library`;
      this.pendingSpotifyRemoval = { ...target, type: "playlist", confirmation, confirmable: false };
      this.pendingSpotifyPlaylistEdit = null;
      return { provider: "spotify", state: "preview", name: target.name, confirmation,
        effect: "Remove this playlist from your Spotify library (unfollow). It may still exist for other listeners; this does not delete it globally." };
    }
    const draft = this.pendingSpotifyRemoval;
    if (action !== "confirm" || !draft?.confirmable || playlistRefId !== undefined || itemRefId !== undefined ||
        transaction.userText?.trim().replace(/[.!。！]$/u, "") !== draft.confirmation) {
      throw spotifyResolutionError("spotify_removal_confirmation_required", "Confirm the exact displayed removal phrase in a later turn. No playlist was removed.");
    }
    this.requireSpotifyWriteScopes([draft.type === "playlist" ? "playlist-modify-public" : "user-library-modify"]);
    transaction.removalAttempted = true;
    // Consume the confirmation before dispatch; cancellation/uncertainty cannot replay it.
    this.pendingSpotifyRemoval = null;
    this.pendingSpotifyPlaylistEdit = null;
    transaction.editInvalidated = true;
    try {
      const receipt = draft.type === "playlist" ?
        await service.removePlaylistFromLibrary({ playlistId: draft.playlistId, expectedName: draft.name, expectedSnapshotId: draft.snapshotId }, { signal }) :
        await service.removeSavedItem({ uri: draft.uri }, { signal });
      transaction.externalized = true;
      this.resetSpotifyPlaylistInspection();
      return receipt;
    } catch (error) {
      if (error?.outcomeUnknown) { transaction.externalized = true; error.spotifyQuickTarget = draft.name; }
      throw error;
    }
  }

  async spotifyPreviewPlaylistEdit({ playlistRefId, intent, items } = {}) {
    const transaction = this.pendingPlaylistPromptTransaction;
    if (transaction?.removalPreviewAttempted || transaction?.removalAttempted || transaction?.removalConfirmationRequested) {
      throw spotifyResolutionError("spotify_confirmation_flow_conflict", "Finish the current library removal flow before previewing a playlist edit.");
    }
    if (this.pendingPlaylistPromptTransaction?.quickEditAttempted) {
      throw spotifyResolutionError("spotify_playlist_edit_already_attempted", "A quick edit was already attempted in this turn. Inspect its receipt before starting another edit request.");
    }
    if (this.pendingPlaylistPromptTransaction) this.pendingPlaylistPromptTransaction.playlistEditPreviewAttempted = true;
    this.requireSpotifyScopes(["user-read-private", "playlist-read-private"]);
    this.requireSpotifyPlaylistTarget(playlistRefId);
    const snapshot = this.spotifyPlaylistSnapshots.get(playlistRefId);
    if (!snapshot) {
      throw spotifyResolutionError(
        "spotify_playlist_not_inspected",
        "Inspect the Spotify playlist in this prompt before previewing an edit.",
      );
    }
    if (
      typeof intent !== "string" ||
      !intent.trim() ||
      Array.from(intent).length > 500
    ) {
      throw spotifyResolutionError(
        "invalid_spotify_playlist_edit_intent",
        "The Spotify playlist edit intent is invalid.",
      );
    }
    if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
      throw spotifyResolutionError(
        "invalid_spotify_playlist_edit_items",
        "A Spotify playlist edit must contain 1 to 100 final tracks.",
      );
    }

    const existingRefs = new Set();
    const finalItems = [];
    for (const item of items) {
      const hasExisting =
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof item.playlistItemRefId === "string";
      const hasAdded =
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof item.trackRefId === "string";
      if (hasExisting === hasAdded) {
        throw spotifyResolutionError(
          "invalid_spotify_playlist_edit_items",
          "Each final playlist position must reference either one inspected item or one resolved track.",
        );
      }
      if (hasExisting) {
        const retained = this.spotifyPlaylistItems.get(item.playlistItemRefId);
        if (
          !retained ||
          retained.playlistRefId !== playlistRefId ||
          existingRefs.has(item.playlistItemRefId)
        ) {
          throw spotifyResolutionError(
            "invalid_spotify_playlist_item_ref",
            "An inspected Spotify playlist item reference is invalid or repeated.",
          );
        }
        existingRefs.add(item.playlistItemRefId);
        finalItems.push({
          uri: retained.uri,
          source: "existing",
          playlistItemRefId: item.playlistItemRefId,
          originalPosition: retained.position,
          metadata: this.spotifyPlaylistPreviewMetadata(retained.metadata),
        });
        continue;
      }

      const resolution = this.requireSpotifyResolution(item.trackRefId);
      let trustedTrack = null;
      if (!resolution.matched && this.playlistServicesReady()) {
        [trustedTrack] = this.requirePlaylistServices().getTrustedTracks([
          item.trackRefId,
        ]);
      }
      finalItems.push({
        uri: resolution.uri,
        source: "added",
        trackRefId: item.trackRefId,
        metadata: this.spotifyPlaylistPreviewMetadata(
          resolution.matched,
          trustedTrack ?? {},
        ),
      });
    }

    const oldUris = snapshot.items.map((item) => item.uri);
    const finalUris = finalItems.map((item) => item.uri);
    if (
      oldUris.length === finalUris.length &&
      oldUris.every((uri, index) => uri === finalUris[index])
    ) {
      throw spotifyResolutionError(
        "spotify_playlist_edit_unchanged",
        "The preview is identical to the current Spotify playlist.",
      );
    }

    const removed = snapshot.items.filter(
      (item) => !existingRefs.has(item.playlistItemRefId),
    );
    const projectedItems = finalItems.map((item, index) => ({
      position: index + 1,
      status:
        item.source === "added"
          ? "added"
          : item.originalPosition === index + 1
            ? "retained"
            : "moved",
      ...structuredClone(item.metadata),
    }));
    const preview = {
      provider: "spotify",
      action: "playlist.edit",
      state: "preview",
      intent: intent.replace(/\s+/gu, " ").trim(),
      playlist: {
        playlist_ref_id: playlistRefId,
        name: snapshot.name,
        before_track_count: snapshot.items.length,
        after_track_count: finalItems.length,
        is_public: false,
      },
      changes: {
        added: finalItems.filter((item) => item.source === "added").length,
        removed: removed.length,
        moved: projectedItems.filter((item) => item.status === "moved").length,
        retained: projectedItems.filter((item) => item.status === "retained").length,
      },
      items: projectedItems,
      removed_items: removed.map((item) => ({
        previous_position: item.position,
        ...this.spotifyPlaylistPreviewMetadata(item.metadata),
      })),
      requires_confirmation: true,
      confirmation_timing: "next_prompt",
      external_effects: "none",
    };
    this.pendingSpotifyPlaylistEdit = {
      confirmable: false,
      playlistId: snapshot.playlistId,
      expectedSnapshotId: snapshot.snapshotId,
      uris: finalUris,
      preview: structuredClone(preview),
    };
    this.pendingSpotifyRemoval = null;
    this.pendingSpotifyPlaylist = null;
    this.pendingPlaylistRevisionCandidateSet = null;
    return preview;
  }

  pendingSpotifyPlaylistEditStatus() {
    const draft = this.pendingSpotifyPlaylistEdit;
    if (!draft) return { state: "none" };
    return {
      state: "available",
      confirmable: draft.confirmable === true,
      lifetime: "current_process_until_replaced_written_or_stale",
      exact_draft_retained_by_host: true,
      preview: {
        action: draft.preview.action,
        intent: draft.preview.intent,
        playlist: structuredClone(draft.preview.playlist),
        changes: structuredClone(draft.preview.changes),
      },
    };
  }

  async spotifyApplyPendingPlaylistEdit({ signal } = {}) {
    signal?.throwIfAborted();
    const transaction = this.pendingPlaylistPromptTransaction;
    if (this.pendingSpotifyRemoval || transaction?.removalPreviewAttempted || transaction?.removalAttempted || transaction?.removalConfirmationRequested) {
      throw spotifyResolutionError("spotify_confirmation_flow_conflict", "A library removal confirmation cannot authorize a playlist edit. Confirm the displayed action only.");
    }
    const draft = this.pendingSpotifyPlaylistEdit;
    if (!draft) {
      throw spotifyResolutionError(
        "spotify_pending_playlist_edit_unavailable",
        "There is no pending Spotify playlist edit to apply. Inspect and preview an edit first.",
      );
    }
    if (draft.confirmable !== true) {
      throw spotifyResolutionError(
        "spotify_playlist_edit_confirmation_required",
        "A Spotify playlist edit can be applied only after the preview completes and the user confirms it in a later prompt.",
      );
    }
    this.requireSpotifyScopes(["user-read-private", "playlist-read-private"]);
    this.requireSpotifyWriteScopes(["playlist-modify-private"]);
    if (transaction) transaction.playlistEditAttempted = true;
    try {
      const receipt = await this.requireSpotifyService().replacePlaylistItems({
        playlistId: draft.playlistId,
        expectedSnapshotId: draft.expectedSnapshotId,
        uris: draft.uris,
      }, { signal });
      if (this.pendingPlaylistPromptTransaction) {
        this.pendingPlaylistPromptTransaction.externalized = true;
      }
      this.pendingSpotifyPlaylistEdit = null;
      return receipt;
    } catch (error) {
      if (error?.outcomeUnknown === true) {
        this.pendingSpotifyPlaylistEdit = null;
        if (this.pendingPlaylistPromptTransaction) this.pendingPlaylistPromptTransaction.externalized = true;
      }
      if (error?.code === "playlist_snapshot_changed") {
        this.pendingSpotifyPlaylistEdit = null;
        if (this.pendingPlaylistPromptTransaction) {
          this.pendingPlaylistPromptTransaction.editInvalidated = true;
        }
      }
      throw error;
    }
  }

  async spotifyCreatePlaylist({ name, description, trackRefs } = {}, { signal } = {}) {
    signal?.throwIfAborted();
    if (
      !Array.isArray(trackRefs) ||
      !Array.isArray(this.validatedPlaylistTrackRefs) ||
      trackRefs.length !== this.validatedPlaylistTrackRefs.length ||
      trackRefs.some(
        (trackRefId, index) =>
          trackRefId !== this.validatedPlaylistTrackRefs[index],
      )
    ) {
      throw spotifyResolutionError(
        "spotify_playlist_plan_required",
        "Spotify playlist writes require the exact validated playlist plan from this prompt.",
      );
    }
    const details = spotifyPlaylistDetails({ name, description });
    this.requireSpotifyWriteScopes(["playlist-modify-private"]);
    const uris = this.requireSpotifyTrackUris(trackRefs);
    return this.writeSpotifyPlaylist(details, uris, { signal });
  }

  pendingSpotifyPlaylistStatus() {
    const plan = this.pendingSpotifyPlaylist?.plan;
    if (!plan) return { state: "none" };
    const candidateSet = this.pendingPlaylistRevisionCandidateSet;
    return {
      state: "available",
      track_count: plan.track_count,
      intent: plan.intent,
      lifetime: "current_process_until_replaced_or_written",
      revision: candidateSet
        ? {
            state: "ready",
            candidate_set_id: candidateSet.candidate_set_id,
            candidate_scope: candidateSet.candidate_scope,
            expires_on: candidateSet.expires_on,
            allowed_operations: ["reorder", "remove", "replace", "add"],
            requires_playlist_plan_validation: true,
            external_effects: "none_until_explicit_write",
            ordering_rationale: plan.ordering_rationale,
            tracks: structuredClone(plan.tracks),
            discovery_sources: this.pendingPlaylistDiscoverySources(),
          }
        : {
            state: "available_on_next_prompt",
            requires_playlist_plan_validation: true,
          },
    };
  }

  pendingSpotifyPlaylistPlan() {
    if (!this.pendingSpotifyPlaylist?.plan) {
      throw spotifyResolutionError(
        "spotify_pending_playlist_unavailable",
        "There is no pending validated playlist plan to save. Create a playlist plan first.",
      );
    }
    return structuredClone(this.pendingSpotifyPlaylist.plan);
  }

  async spotifyCreatePendingPlaylist({ name, description } = {}, { signal } = {}) {
    signal?.throwIfAborted();
    if (!this.pendingSpotifyPlaylist) {
      throw spotifyResolutionError(
        "spotify_pending_playlist_unavailable",
        "There is no pending validated playlist plan to save. Create a playlist plan first.",
      );
    }
    const details = spotifyPlaylistDetails({ name, description });
    this.requireSpotifyScopes(["user-read-private"]);
    this.requireSpotifyWriteScopes(["playlist-modify-private"]);
    const draft = this.pendingSpotifyPlaylist;
    const result = await this.requireSpotifyResolver().resolve(
      draft.trustedTracks,
      { signal },
    );
    signal?.throwIfAborted();
    const resolvedByRef = new Map();
    for (const resolution of result.resolutions ?? []) {
      if (resolution.status === "resolved" && resolution.spotify?.uri) {
        resolvedByRef.set(
          resolution.track_ref_id,
          resolution.spotify.uri,
        );
      }
    }
    const uris = draft.plan.tracks.map((track) =>
      resolvedByRef.get(track.track_ref_id),
    );
    if (uris.some((uri) => typeof uri !== "string")) {
      throw spotifyResolutionError(
        "spotify_pending_playlist_unresolved",
        "The pending playlist could not be fully resolved on Spotify, so no playlist was created.",
      );
    }
    return this.writeSpotifyPlaylist(details, uris, { signal });
  }

  async spotifyPlayPendingPlan({ deviceId } = {}, { signal } = {}) {
    signal?.throwIfAborted();
    if (!this.pendingSpotifyPlaylist?.plan) {
      throw spotifyResolutionError(
        "spotify_pending_playlist_unavailable",
        "There is no pending validated playlist plan to play. Create a playlist plan first.",
      );
    }
    this.requireSpotifyScopes(["user-read-private"]);
    const draft = this.pendingSpotifyPlaylist;
    const result = await this.requireSpotifyResolver().resolve(draft.trustedTracks, { signal });
    signal?.throwIfAborted();
    const resolvedByRef = new Map(
      (result.resolutions ?? [])
        .filter((resolution) => resolution.status === "resolved" && resolution.spotify?.uri)
        .map((resolution) => [resolution.track_ref_id, resolution.spotify.uri]),
    );
    const uris = draft.plan.tracks.map((track) => resolvedByRef.get(track.track_ref_id));
    if (uris.some((uri) => typeof uri !== "string")) {
      throw spotifyResolutionError(
        "spotify_pending_playback_unresolved",
        "The pending plan could not be fully resolved on Spotify, so playback was not changed.",
      );
    }
    const receipt = await this.requireSpotifyService().resume({
      uris,
      ...(deviceId ? { deviceId } : {}),
    }, { signal });
    return { ...receipt, track_count: uris.length };
  }

  async spotifyQueuePendingPlan({ deviceId } = {}, { signal } = {}) {
    signal?.throwIfAborted();
    if (!this.pendingSpotifyPlaylist?.plan) {
      throw spotifyResolutionError(
        "spotify_pending_playlist_unavailable",
        "There is no pending validated playlist plan to queue. Create a playlist plan first.",
      );
    }
    this.requireSpotifyScopes(["user-read-private"]);
    const draft = this.pendingSpotifyPlaylist;
    const result = await this.requireSpotifyResolver().resolve(
      draft.trustedTracks,
      { signal },
    );
    signal?.throwIfAborted();
    const resolvedByRef = new Map();
    for (const resolution of result.resolutions ?? []) {
      if (resolution.status === "resolved" && resolution.spotify?.uri) {
        resolvedByRef.set(resolution.track_ref_id, resolution.spotify.uri);
      }
    }
    const receipt = await this.#queueSpotifyTracks(draft.plan.tracks, resolvedByRef, { signal, deviceId });
    if (receipt.state === "no_candidates") {
      throw spotifyResolutionError("spotify_pending_queue_unmatched", "None of the pending tracks matched a Spotify track, so nothing was queued.");
    }
    return receipt;
  }

  async #queueSpotifyTracks(tracks, resolvedByRef, { signal, deviceId, seenUris = null, limit = tracks.length, domainServices = null } = {}) {
    const label = (track) => ({ title: track.title, artist_credit: track.artist_credit });
    const queued = [];
    const unmatched = [];
    let skippedDuplicates = 0;
    let skippedAvoids = 0;
    let stopped = null;
    let stopIndex = -1;
    let outcomeUnknown = false;
    for (const [index, track] of tracks.entries()) {
      if (queued.length >= limit) break;
      if (signal?.aborted) { stopped = label(track); stopIndex = index; break; }
      if (domainServices?.filterDiscoveryTracks?.([track]).length === 0) { skippedAvoids++; continue; }
      const uri = resolvedByRef.get(track.track_ref_id);
      if (typeof uri !== "string") { unmatched.push(label(track)); continue; }
      if (seenUris?.has(uri)) { skippedDuplicates++; continue; }
      try {
        await this.requireSpotifyService().addToQueue({ uri, ...(deviceId ? { deviceId } : {}) }, { signal });
        queued.push(label(track));
        seenUris?.add(uri);
        if (seenUris) {
          this.recentSimilarQueueUris.set(uri, Date.now());
          while (this.recentSimilarQueueUris.size > 100) this.recentSimilarQueueUris.delete(this.recentSimilarQueueUris.keys().next().value);
        }
      } catch (error) {
        stopped = label(track); stopIndex = index;
        // A received rejection or pre-dispatch cancellation is known; transport
        // failures may have applied the write. Never continue or replay it.
        const rejected = error?.outcomeUnknown === false ||
          (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) ||
          (error?.name === "AbortError" && signal?.aborted) || /^invalid_|^spotify_(?:auth|device|active_device|.*scopes)_/u.test(error?.code ?? "");
        outcomeUnknown = error?.outcomeUnknown === true || !rejected;
        break;
      }
    }
    if (queued.length === 0 && !outcomeUnknown) signal?.throwIfAborted();
    const state = stopped ? (queued.length ? "partial" : outcomeUnknown ? "unknown" : "failed")
      : queued.length ? "accepted" : "no_candidates";
    return { provider: "spotify", ok: !["unknown", "failed"].includes(state), effect: "write_external", action: "playback.queue.add",
      state, queued, unmatched, not_added: stopIndex >= 0 ? tracks.slice(stopIndex + 1).map(label) : [],
      skipped_duplicate_count: skippedDuplicates, skipped_avoided_count: skippedAvoids,
      ...(stopped ? { stopped } : {}), ...(outcomeUnknown ? { outcome_unknown: true } : {}),
      ...(signal?.aborted ? { cancelled: true } : {}) };
  }

  async writeSpotifyPlaylist(details, uris, { signal } = {}) {
    signal?.throwIfAborted();
    try {
      const receipt = await this.requireSpotifyService().createPlaylistWithTracks({
        ...details,
        uris,
      }, { signal });
      if (this.pendingPlaylistPromptTransaction) {
        this.pendingPlaylistPromptTransaction.externalized = true;
      }
      this.pendingSpotifyPlaylist = null;
      this.pendingPlaylistRevisionCandidateSet = null;
      return receipt;
    } catch (error) {
      if (error?.outcomeUnknown === true || ["playlist_created_without_tracks", "playlist_created_tracks_unknown"].includes(error?.code)) {
        if (this.pendingPlaylistPromptTransaction) {
          this.pendingPlaylistPromptTransaction.externalized = true;
        }
        this.pendingSpotifyPlaylist = null;
        this.pendingPlaylistRevisionCandidateSet = null;
      }
      throw error;
    }
  }

  async spotifySaveLibraryTracks({ trackRefs } = {}, { signal } = {}) {
    signal?.throwIfAborted();
    this.requireSpotifyWriteScopes(["user-library-modify"]);
    const uris = this.requireSpotifyTrackUris(trackRefs);
    return this.requireSpotifyService().saveTracks({ uris }, { signal });
  }

  async spotifyCheckLibraryTracks({ trackRefs } = {}, { signal } = {}) {
    signal?.throwIfAborted();
    this.requireSpotifyScopes(["user-library-read"]);
    const uris = this.requireSpotifyTrackUris(trackRefs);
    const result = await this.requireSpotifyService().checkSavedTracks({
      uris,
    }, { signal });
    signal?.throwIfAborted();
    return {
      provider: "spotify",
      checked: result.checked.map((entry, index) => ({
        track_ref_id: trackRefs[index],
        saved: entry.saved,
      })),
    };
  }

  webResearchReady() {
    return this.webResearch?.publicStatus().state === "configured";
  }

  async searchWeb(input, options) {
    if (!this.webResearchReady()) throw new Error("Codex web search is unavailable. Run /web status for setup details.");
    return this.webResearch.search(input, options);
  }

  async readWeb(input, options) {
    if (!this.webResearchReady()) throw new Error("Codex web reading is unavailable. Run /web status for setup details.");
    return this.webResearch.read(input, options);
  }

  toolsStatus() {
    return {
      registry_version:
        "a3-s3-open-similarity+a4-s4+rediscovery+historical-returns+time-capsule+back-to-back/1",
      capabilities: listCapabilities({
        domainServicesReady: this.domainServicesReady(),
        profileServicesReady: this.profileServicesReady(),
        playlistServicesReady: this.playlistServicesReady(),
        rediscoveryReady: this.rediscoveryServicesReady(),
        historicalReturnReady: this.historicalReturnServicesReady(),
        timeCapsuleReady: this.timeCapsuleServicesReady(),
        backToBackReady: this.backToBackServicesReady(),
        memoryReady: this.memoryStore !== null,
        spotifyReady: this.spotifyReady(),
        musicCatalogReady: this.musicCatalogReady(),
        musicDiscoveryReady: this.musicDiscoveryReady(),
        musicSimilarityReady: this.musicSimilarityReady(),
        webResearchReady: this.webResearchReady(),
      }),
    };
  }

  agentCapabilityDescriptors() {
    return listAgentCapabilityDescriptors({
      domainServicesReady: this.domainServicesReady(),
      profileServicesReady: this.profileServicesReady(),
      playlistServicesReady: this.playlistServicesReady(),
      rediscoveryReady: this.rediscoveryServicesReady(),
      historicalReturnReady: this.historicalReturnServicesReady(),
      timeCapsuleReady: this.timeCapsuleServicesReady(),
      backToBackReady: this.backToBackServicesReady(),
      memoryReady: this.memoryStore !== null,
      spotifyReady: this.spotifyReady(),
      musicCatalogReady: this.musicCatalogReady(),
      musicDiscoveryReady: this.musicDiscoveryReady(),
      musicSimilarityReady: this.musicSimilarityReady(),
      webResearchReady: this.webResearchReady(),
    });
  }

  async findArtistReleases(input) {
    const request = { ...input };
    if (
      request.knownRelease === undefined &&
      this.domainServicesReady()
    ) {
      try {
        const localMatches = await this.requireDomainServices().searchLibrary({
          query: request.artistName,
          limit: 12,
          offset: 0,
          filters: {
            artists: [request.artistName],
          },
        });
        const knownRelease = exactArtistReleaseHint(
          localMatches,
          request.artistName,
        );
        if (knownRelease) request.knownRelease = knownRelease;
      } catch {
        // Catalog lookup remains useful when the optional local hint is unavailable.
      }
    }
    const catalog = this.requireMusicCatalog();
    const result = await catalog.findArtistReleases(request);
    return recoverArtistReleasesWithCrossCatalogIdentity({
      artistName: request.artistName,
      currentResult: result,
      catalog,
      identityResolver: this.artistIdentityResolver,
    });
  }

  recordPromptDiscoverySource(source) {
    if (!source || typeof source !== "object" || Array.isArray(source)) return;
    if (
      this.promptDiscoverySources.some(
        (entry) =>
          entry.provider === source.provider &&
          entry.retrieved_at === source.retrieved_at,
      )
    ) {
      return;
    }
    this.promptDiscoverySources.push(structuredClone(source));
  }

  pendingPlaylistDiscoverySources() {
    return structuredClone(this.pendingSpotifyPlaylist?.discoverySources ?? []);
  }

  async searchMusicCatalog(input) {
    const { catalog, domainServices } = this.requireMusicDiscovery();
    const result = await catalog.searchTracks(input);
    if (result.state !== "resolved" || result.tracks.length === 0) {
      return {
        ...result,
        candidate_set_id: null,
        candidate_scope: "external_catalog",
        excluded_library_matches: 0,
        expires_on: "prompt_end",
      };
    }
    const registered = domainServices.registerExternalCandidateSet({
      tracks: result.tracks,
      source: result.source,
    });
    if (registered.result_count > 0) {
      this.recordPromptDiscoverySource(registered.source);
    }
    return {
      ...result,
      ...registered,
      state:
        registered.result_count > 0
          ? "resolved"
          : "not_found_after_library_filter",
    };
  }

  async discoverSimilarMusic({ seedTrackRefId, mode, limit } = {}) {
    const { similarity, domainServices } = this.requireMusicSimilarity();
    const seedTrack = this.promptProfileSeed?.track_ref_id === seedTrackRefId
      ? this.promptProfileSeed
      : domainServices.getTrustedTracks([seedTrackRefId])[0];
    const result = await similarity.discoverSimilarTracks({
      artistName: seedTrack.artist_credit,
      mode,
      limit,
    });
    const seed = {
      track_ref_id: seedTrack.track_ref_id,
      title: seedTrack.title,
      artist_credit: seedTrack.artist_credit,
      release: seedTrack.release,
      ...result.seed,
    };
    if (result.state !== "resolved" || result.tracks.length === 0) {
      return {
        ...result,
        seed,
        candidate_set_id: null,
        candidate_scope: "external_catalog",
        excluded_library_matches: 0,
        expires_on: "prompt_end",
      };
    }
    const registered = domainServices.registerExternalCandidateSet({
      tracks: result.tracks,
      source: result.source,
    });
    if (registered.result_count > 0) {
      this.recordPromptDiscoverySource(registered.source);
    }
    return {
      ...result,
      ...registered,
      seed,
      state:
        registered.result_count > 0
          ? "resolved"
          : "not_found_after_library_filter",
    };
  }

  async searchLibrary(input) {
    return this.requireDomainServices().searchLibrary(input);
  }

  async getProfileSummary(input) {
    return this.requireProfileServices().getProfileSummary(input);
  }

  // Host-only personalization; lyric text is not injected into model context.
  async getLyricSeeds() {
    if (!this.profileServicesReady()) return { subjectId: null, tracks: [] };
    return this.requireProfileServices().getLyricSeeds?.() ?? { subjectId: null, tracks: [] };
  }

  // Host-only handoff from a track selected in the local profile, never a model tool.
  setProfileDiscoverySeed(selection) {
    if (!this.pendingPlaylistPromptTransaction) {
      throw new Error("A selected profile track requires an active prompt.");
    }
    const clean = (value) => typeof value === "string"
      ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, " ")
        .replace(/\s+/gu, " ").trim()
      : "";
    const title = clean(selection?.label);
    const artist = clean(selection?.artistCredit);
    if (selection?.entityType !== "track" || !title || !artist ||
        Array.from(title).length > 512 || Array.from(artist).length > 512) {
      throw new TypeError("The selected profile track is invalid.");
    }
    this.promptProfileSeed = {
      track_ref_id: randomUUID(),
      title,
      artist_credit: artist,
      source: "user_selected_profile_track",
      expires_on: "prompt_end",
    };
  }

  profileDiscoverySeedContext() {
    return structuredClone(this.promptProfileSeed);
  }

  async getRediscoveryCandidates(input) {
    return this.requireRediscoveryServices().getRediscoveryCandidates(input);
  }

  async getHistoricalReturnCandidates(input) {
    return this.requireHistoricalReturnServices()
      .getHistoricalReturnCandidates(input);
  }

  async getTimeCapsuleCandidates(input) {
    return this.requireTimeCapsuleServices().getTimeCapsuleCandidates(input);
  }

  async getBackToBackCandidates(input) {
    return this.requireBackToBackServices().getBackToBackCandidates(input);
  }

  async explainProfileEvidence(input) {
    return this.requireProfileServices().explainProfileEvidence(input);
  }

  async buildPlaylistPlan(input) {
    const plan = await this.requirePlaylistServices().buildPlaylistPlan(input);
    const validatedPlaylistTrackRefs = Array.isArray(plan?.tracks)
      ? plan.tracks.map((track) => track.track_ref_id)
      : null;
    const trustedTracks = validatedPlaylistTrackRefs
      ? this.requirePlaylistServices().getTrustedTracks(
          validatedPlaylistTrackRefs,
        )
      : null;
    if (trustedTracks) {
      const byRef = new Map(trustedTracks.map((track) => [track.track_ref_id, track]));
      for (const track of plan.tracks) {
        // Presentation evidence comes from registered candidates, never model prose.
        delete track.discovery_evidence;
        const trusted = byRef.get(track.track_ref_id);
        if (track.candidate_scope !== "external_catalog" || trusted?.candidate_scope !== "external_catalog") continue;
        if (trusted.catalog_provider === "listenbrainz" && trusted.discovery_basis) {
          track.discovery_evidence = {
            provider: "listenbrainz",
            seed_artist: trusted.discovery_basis.seed_artist,
            adjacent_artist: trusted.discovery_basis.adjacent_artist,
          };
        } else if (trusted.catalog_provider === "apple_music") {
          track.discovery_evidence = {
            provider: "apple_music",
            matched_queries: [...(trusted.matched_queries ?? [])],
            ...(trusted.primary_genre ? { primary_genre: trusted.primary_genre } : {}),
          };
        }
      }
    }
    this.validatedPlaylistTrackRefs = validatedPlaylistTrackRefs;
    this.pendingSpotifyPlaylist = validatedPlaylistTrackRefs
      ? {
          plan: structuredClone(plan),
          trustedTracks,
          discoverySources: structuredClone(this.promptDiscoverySources),
        }
      : null;
    this.pendingSpotifyPlaylistEdit = null;
    this.pendingPlaylistRevisionCandidateSet = null;
    return plan;
  }

  commitPendingPlaylistPrompt() {
    const active = this.pendingPlaylistPromptTransaction !== null;
    if (this.pendingSpotifyPlaylistEdit?.confirmable === false) {
      this.pendingSpotifyPlaylistEdit.confirmable = true;
    }
    if (this.pendingSpotifyRemoval?.confirmable === false) this.pendingSpotifyRemoval.confirmable = true;
    this.pendingPlaylistPromptTransaction = null;
    return { committed_pending_playlist_prompt: active };
  }

  rollbackPendingPlaylistPrompt() {
    const transaction = this.pendingPlaylistPromptTransaction;
    if (!transaction) {
      return { rolled_back_pending_playlist_prompt: false };
    }
    if (!transaction.removalAttempted && !transaction.removalInvalidated) this.pendingSpotifyRemoval = structuredClone(transaction.pendingSpotifyRemoval);
    if (!transaction.externalized) {
      this.pendingSpotifyPlaylist = structuredClone(
        transaction.pendingSpotifyPlaylist,
      );
      this.pendingSpotifyPlaylistEdit = transaction.editInvalidated
        ? null
        : structuredClone(transaction.pendingSpotifyPlaylistEdit);
    }
    this.pendingPlaylistPromptTransaction = null;
    return {
      rolled_back_pending_playlist_prompt: !transaction.externalized,
      external_effect_preserved: transaction.externalized,
    };
  }

  beginPrompt({ text } = {}) {
    if (this.pendingPlaylistPromptTransaction) {
      throw new Error("A Moondog prompt state transaction is already active.");
    }
    this.pendingPlaylistPromptTransaction = {
      userText: text,
      removalConfirmationRequested: /^Confirm removal of (?:playlist|track|album|episode|show) .+ from my library[.!。！]?$/u.test(text?.trim() ?? ""),
      pendingSpotifyRemoval: structuredClone(this.pendingSpotifyRemoval),
      pendingSpotifyPlaylist: structuredClone(this.pendingSpotifyPlaylist),
      pendingSpotifyPlaylistEdit: structuredClone(
        this.pendingSpotifyPlaylistEdit,
      ),
      externalized: false,
      editInvalidated: false,
      quickEditIntent: explicitQuickPlaylistIntent(text),
    };
    this.resetSpotifyResolutions();
    this.resetSpotifyPlaylistInspection();
    this.promptProfileSeed = null;
    this.pendingPlaylistRevisionCandidateSet = null;
    this.promptDiscoverySources = structuredClone(
      this.pendingSpotifyPlaylist?.discoverySources ?? [],
    );
    if (!this.playlistServicesReady()) return undefined;
    try {
      const result = this.domainServices.beginPrompt();
      if (!this.pendingSpotifyPlaylist?.trustedTracks) return result;
      this.pendingPlaylistRevisionCandidateSet =
        this.domainServices.registerRetainedPlaylistCandidateSet({
          tracks: this.pendingSpotifyPlaylist.trustedTracks,
        });
      return result;
    } catch (error) {
      this.domainServices.resetCandidateSets();
      this.pendingPlaylistRevisionCandidateSet = null;
      this.promptDiscoverySources = [];
      this.pendingPlaylistPromptTransaction = null;
      throw error;
    }
  }

  endPrompt() {
    this.resetSpotifyResolutions();
    this.resetSpotifyPlaylistInspection();
    try {
      const result = this.playlistServicesReady()
        ? this.domainServices.endPrompt()
        : undefined;
      this.commitPendingPlaylistPrompt();
      return result;
    } catch (error) {
      this.rollbackPendingPlaylistPrompt();
      throw error;
    } finally {
      this.pendingPlaylistRevisionCandidateSet = null;
      this.promptDiscoverySources = [];
      this.promptProfileSeed = null;
    }
  }

  resetPromptState() {
    this.resetSpotifyResolutions();
    this.resetSpotifyPlaylistInspection();
    try {
      if (!this.playlistServicesReady()) return undefined;
      return this.domainServices.resetCandidateSets();
    } finally {
      this.rollbackPendingPlaylistPrompt();
      this.pendingPlaylistRevisionCandidateSet = null;
      this.promptDiscoverySources = [];
      this.promptProfileSeed = null;
    }
  }

  close() {
    try {
      this.memorySession = null;
      this.pendingSpotifyPlaylist = null;
      this.pendingSpotifyPlaylistEdit = null;
      this.pendingPlaylistRevisionCandidateSet = null;
      this.resetSpotifyPlaylistInspection();
      this.promptDiscoverySources = [];
      this.promptProfileSeed = null;
      this.pendingPlaylistPromptTransaction = null;
    } finally {
      this.memoryStore?.close?.();
      this.domainServices?.close?.();
      this.musicCatalog?.close?.();
      this.musicSimilarity?.close?.();
      this.webResearch?.close?.();
    }
  }

  async status(runtime = { state: "offline" }) {
    return {
      product: "moondog",
      milestone: "A3-S3+A4-S4",
      client: "cli_tui",
      runtime,
      source: await this.sourceStatus(),
      profile: await this.profileStatus(),
      memory: this.memoryStatus(),
      web_research: this.webResearch?.publicStatus?.() ?? { provider: "codex_cli", state: "unavailable" },
      music_catalog: {
        provider: "apple_music",
        state: this.musicCatalogReady() ? "configured" : "unavailable",
        access: "read_only",
        external_candidate_planning: this.musicDiscoveryReady(),
      },
      music_similarity: {
        provider: "listenbrainz",
        identity_provider: "wikidata",
        state: this.musicSimilarityReady() ? "configured" : "unavailable",
        access: "read_only",
        external_candidate_planning: this.musicSimilarityReady(),
      },
      spotify: this.spotifyStatus(),
      external_effects: this.spotifyReady() ? "spotify_control" : "disabled",
    };
  }

  async doctor(runtime = { state: "offline" }) {
    const source = await this.sourceStatus();
    const profile = await this.profileStatus();
    const spotify = this.spotifyStatus();
    const checks = [
      {
        id: "web.codex_cli",
        ok: this.webResearchReady(),
        state: this.webResearchReady() ? "configured" : "unavailable",
        optional_for_local_commands: true,
      },
      {
        id: "node.version",
        ok: versionAtLeast(process.versions.node, minimumNodeVersion),
        actual: process.versions.node,
        required: ">=22.19.0",
      },
      {
        id: "apple_music.source",
        ok: ["ready", "degraded"].includes(source.state),
        state: source.state,
        optional_for_local_commands: profile.state === "ready",
      },
      {
        id: "profile.projection",
        ok: profile.state === "ready",
        state: profile.state,
        ...(profile.error ? { error: profile.error } : {}),
      },
      {
        id: "agent.runtime",
        ok: runtime.state === "configured",
        state: runtime.state,
        optional_for_local_commands: true,
      },
      {
        id: "music.discovery.open_similarity",
        ok: this.musicSimilarityReady(),
        state: this.musicSimilarityReady() ? "configured" : "unavailable",
      },
      {
        id: "external.effects",
        ok: true,
        state: this.spotifyReady() ? "spotify_control" : "disabled",
      },
      {
        id: "spotify.connection",
        ok: this.spotifyReady(),
        state: spotify.state,
        optional_for_local_commands: true,
      },
      {
        id: "spotify.connected_action_scopes",
        ok: spotify.scopes?.sufficient === true,
        state:
          spotify.scopes?.sufficient === true
            ? "ready"
            : this.spotifyReady()
              ? "reauthentication_required"
              : "not_configured",
        missing_scopes: spotify.scopes?.missing ?? [],
        optional_for_local_commands: true,
      },
    ];

    return {
      ok: checks
        .filter((check) => !check.optional_for_local_commands)
        .every((check) => check.ok),
      checks,
    };
  }

  async runLocalCommand(command, runtime = { state: "offline" }) {
    switch (command) {
      case "status":
      case "sources":
        return this.status(runtime);
      case "profile":
        return this.profileStatus();
      case "taste":
        return this.getProfileSummary({ maxItems: 5 });
      case "memory":
        return this.memorySummary();
      case "tools":
        return this.toolsStatus();
      case "doctor":
        return this.doctor(runtime);
      default:
        throw new Error(`Unknown local command: ${command}`);
    }
  }
}
