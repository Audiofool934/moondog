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

const minimumNodeVersion = [22, 19, 0];

function spotifyResolutionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
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
      this.domainServicesReady() &&
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
      this.domainServicesReady() &&
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

  #clearConversationState() {
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

  async spotifyPlayerStatus() {
    const player = await this.requireSpotifyService().currentPlayer();
    if (player.state !== "available") {
      return { provider: "spotify", state: "inactive" };
    }
    return {
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

  spotifyControl({ action, ...parameters }) {
    const service = this.requireSpotifyService();
    if (action === "resume" && Array.isArray(parameters.trackRefs)) {
      const { trackRefs, ...playbackParameters } = parameters;
      const uris = this.requireSpotifyTrackUris(trackRefs);
      return service.resume({
        ...playbackParameters,
        uris,
      });
    }
    switch (action) {
      case "resume":
        return service.resume(parameters);
      case "pause":
        return service.pause(parameters);
      case "next":
        return service.next(parameters);
      case "previous":
        return service.previous(parameters);
      case "volume":
        return service.setVolume(parameters);
      case "seek":
        return service.seek(parameters);
      case "shuffle":
        return service.setShuffle(parameters);
      case "repeat":
        return service.setRepeat(parameters);
      default:
        throw new Error("Unsupported Spotify player action.");
    }
  }

  spotifyAddToQueue(input) {
    if (input?.trackRefId !== undefined) {
      const resolution = this.requireSpotifyResolution(input.trackRefId);
      return this.requireSpotifyService().addToQueue({
        uri: resolution.uri,
        ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      });
    }
    return this.requireSpotifyService().addToQueue(input);
  }

  spotifyTransfer(input) {
    return this.requireSpotifyService().transfer(input);
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

  async spotifyListEditablePlaylists({ limit, offset } = {}) {
    this.requireSpotifyScopes(["user-read-private", "playlist-read-private"]);
    const result = await this.requireSpotifyService().editablePlaylists({
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    });
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

  async spotifyInspectPlaylist({ playlistRefId } = {}) {
    this.requireSpotifyScopes(["user-read-private", "playlist-read-private"]);
    const target = this.requireSpotifyPlaylistTarget(playlistRefId);
    const snapshot = await this.requireSpotifyService().playlistSnapshot({
      playlistId: target.playlistId,
    });
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
        "Preview only in this prompt. An explicit confirmation in a later prompt is required before Spotify changes.",
    };
  }

  requireSpotifyResolution(trackRefId) {
    const resolution = this.spotifyResolutions.get(trackRefId);
    if (!resolution) {
      throw spotifyResolutionError(
        "spotify_track_not_resolved",
        "The track was not resolved to a Spotify catalog identity in this prompt. Resolve it with the Spotify resolve tool first.",
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

  async spotifyResolveTracks({ trackRefs } = {}) {
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
    this.requireSpotifyScopes(["user-read-private"]);
    const domainServices = this.requirePlaylistServices();
    const trustedTracks = domainServices.getTrustedTracks(trackRefs);
    const resolver = this.requireSpotifyResolver();
    const result = await resolver.resolve(trustedTracks);
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

  async spotifyPreviewPlaylistEdit({ playlistRefId, intent, items } = {}) {
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

  async spotifyApplyPendingPlaylistEdit() {
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
    try {
      const receipt = await this.requireSpotifyService().replacePlaylistItems({
        playlistId: draft.playlistId,
        expectedSnapshotId: draft.expectedSnapshotId,
        uris: draft.uris,
      });
      if (this.pendingPlaylistPromptTransaction) {
        this.pendingPlaylistPromptTransaction.externalized = true;
      }
      this.pendingSpotifyPlaylistEdit = null;
      return receipt;
    } catch (error) {
      if (error?.code === "playlist_snapshot_changed") {
        this.pendingSpotifyPlaylistEdit = null;
        if (this.pendingPlaylistPromptTransaction) {
          this.pendingPlaylistPromptTransaction.editInvalidated = true;
        }
      }
      throw error;
    }
  }

  async spotifyCreatePlaylist({ name, description, trackRefs } = {}) {
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
    return this.writeSpotifyPlaylist(details, uris);
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

  async spotifyCreatePendingPlaylist({ name, description } = {}) {
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
    );
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
    return this.writeSpotifyPlaylist(details, uris);
  }

  async writeSpotifyPlaylist(details, uris) {
    try {
      const receipt = await this.requireSpotifyService().createPlaylistWithTracks({
        ...details,
        uris,
      });
      if (this.pendingPlaylistPromptTransaction) {
        this.pendingPlaylistPromptTransaction.externalized = true;
      }
      this.pendingSpotifyPlaylist = null;
      this.pendingPlaylistRevisionCandidateSet = null;
      return receipt;
    } catch (error) {
      if (error?.code === "playlist_created_without_tracks") {
        if (this.pendingPlaylistPromptTransaction) {
          this.pendingPlaylistPromptTransaction.externalized = true;
        }
        this.pendingSpotifyPlaylist = null;
        this.pendingPlaylistRevisionCandidateSet = null;
      }
      throw error;
    }
  }

  async spotifySaveLibraryTracks({ trackRefs } = {}) {
    this.requireSpotifyWriteScopes(["user-library-modify"]);
    const uris = this.requireSpotifyTrackUris(trackRefs);
    return this.requireSpotifyService().saveTracks({ uris });
  }

  async spotifyCheckLibraryTracks({ trackRefs } = {}) {
    this.requireSpotifyScopes(["user-library-read"]);
    const uris = this.requireSpotifyTrackUris(trackRefs);
    const result = await this.requireSpotifyService().checkSavedTracks({
      uris,
    });
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
    this.pendingPlaylistPromptTransaction = null;
    return { committed_pending_playlist_prompt: active };
  }

  rollbackPendingPlaylistPrompt() {
    const transaction = this.pendingPlaylistPromptTransaction;
    if (!transaction) {
      return { rolled_back_pending_playlist_prompt: false };
    }
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

  beginPrompt() {
    if (this.pendingPlaylistPromptTransaction) {
      throw new Error("A Moondog prompt state transaction is already active.");
    }
    this.pendingPlaylistPromptTransaction = {
      pendingSpotifyPlaylist: structuredClone(this.pendingSpotifyPlaylist),
      pendingSpotifyPlaylistEdit: structuredClone(
        this.pendingSpotifyPlaylistEdit,
      ),
      externalized: false,
      editInvalidated: false,
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
