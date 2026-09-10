const catalog = [
  {
    id: "web.search", version: "1", state: "enabled", effect: "read_external",
    description: "Search public music reviews, news, interviews and event information through the local Codex CLI.",
    requires_web_research: true,
    agent_tool: { name: "moondog_web_search", label: "Search the public web" },
  },
  {
    id: "web.read", version: "1", state: "enabled", effect: "read_external",
    description: "Read and summarize a public web page with dated source attribution through the local Codex CLI.",
    requires_web_research: true,
    agent_tool: { name: "moondog_web_read", label: "Read a public web page" },
  },
  {
    id: "source.apple_music.status",
    version: "1",
    state: "enabled",
    effect: "read_local",
    description: "Inspect aggregate Apple Music import readiness.",
    agent_tool: {
      name: "moondog_source_status",
      label: "Inspect music source status",
    },
  },
  {
    id: "profile.status",
    version: "1",
    state: "enabled",
    effect: "read_local",
    description: "Inspect evidence-backed profile readiness.",
    agent_tool: {
      name: "moondog_profile_status",
      label: "Inspect profile status",
    },
  },
  {
    id: "memory.status",
    version: "1",
    state: "enabled",
    effect: "read_local",
    description: "Inspect conversation and long-term memory readiness.",
    agent_tool: {
      name: "moondog_memory_status",
      label: "Inspect memory status",
    },
  },
  {
    id: "capability.status",
    version: "1",
    state: "enabled",
    effect: "read_local",
    description: "Inspect the Moondog capability registry.",
    agent_tool: {
      name: "moondog_capability_status",
      label: "Inspect capability registry",
    },
  },
  {
    id: "runtime.status",
    version: "1",
    state: "enabled",
    effect: "read_runtime",
    description: "Inspect the configured model runtime.",
    agent_tool: {
      name: "moondog_runtime_status",
      label: "Inspect agent runtime",
    },
  },
  {
    id: "library.search",
    version: "1",
    state: "enabled",
    effect: "read_local",
    description: "Search a bounded view of the private normalized music library.",
    requires_domain_services: true,
    agent_tool: {
      name: "moondog_library_search",
      label: "Search your music library",
    },
  },
  {
    id: "profile.summary",
    version: "1",
    state: "enabled",
    effect: "read_local",
    description: "Read a compact evidence-backed personal music profile.",
    requires_profile_services: true,
    agent_tool: {
      name: "moondog_profile_summary",
      label: "Read your music profile",
    },
  },
  {
    id: "profile.rediscovery",
    version: "1",
    state: "enabled",
    effect: "read_local",
    description:
      "Create a prompt-local playlist candidate set from meaningful older listening that has gone quiet.",
    requires_rediscovery_services: true,
    agent_tool: {
      name: "moondog_rediscovery_candidates",
      label: "Find music worth another listen",
    },
  },
  {
    id: "profile.historical_returns",
    version: "1",
    state: "enabled",
    effect: "read_local",
    description:
      "Create a prompt-local playlist candidate set from tracks that reappeared after long gaps in retained listening history.",
    requires_historical_return_services: true,
    agent_tool: {
      name: "moondog_historical_return_candidates",
      label: "Find music that came back",
    },
  },
  {
    id: "profile.time_capsule",
    version: "1",
    state: "enabled",
    effect: "read_local",
    description:
      "Create a prompt-local chronological candidate set from representative listening years.",
    requires_time_capsule_services: true,
    agent_tool: {
      name: "moondog_time_capsule_candidates",
      label: "Build a Listening Time Machine",
    },
  },
  {
    id: "profile.back_to_back",
    version: "1",
    state: "enabled",
    effect: "read_local",
    description:
      "Create a prompt-local playlist candidate set from bounded adjacent same-track sequences in retained Spotify Extended History.",
    requires_back_to_back_services: true,
    agent_tool: {
      name: "moondog_back_to_back_candidates",
      label: "Find music played back to back",
    },
  },
  {
    id: "profile.explain",
    version: "1",
    state: "enabled",
    effect: "read_local",
    description: "Explain one bounded profile evidence record.",
    requires_profile_services: true,
    agent_tool: {
      name: "moondog_profile_explain",
      label: "Explain profile evidence",
    },
  },
  {
    id: "playlist.plan",
    version: "1",
    state: "enabled",
    effect: "derive_local",
    description: "Validate and derive an inspectable in-memory playlist plan.",
    requires_playlist_services: true,
    agent_tool: {
      name: "moondog_playlist_plan",
      label: "Build a playlist plan",
    },
  },
  {
    id: "music.catalog.artist_releases",
    version: "1",
    state: "enabled",
    effect: "read_external",
    description:
      "Find dated artist releases in a bounded external music catalog.",
    requires_music_catalog: true,
    agent_tool: {
      name: "moondog_music_artist_releases",
      label: "Find current artist releases",
    },
  },
  {
    id: "music.catalog.track_search",
    version: "1",
    state: "enabled",
    effect: "read_external",
    description:
      "Search bounded external catalog candidates and register them for prompt-local planning.",
    requires_music_discovery: true,
    agent_tool: {
      name: "moondog_music_catalog_search",
      label: "Search outside your library",
    },
  },
  {
    id: "music.discovery.artist_similarity",
    version: "1",
    state: "enabled",
    effect: "read_external",
    description:
      "Find bounded external candidates through open listening-derived artist similarity.",
    requires_music_similarity: true,
    agent_tool: {
      name: "moondog_music_artist_similarity",
      label: "Discover adjacent music",
    },
  },
  {
    id: "memory.inspect",
    version: "1",
    state: "enabled",
    effect: "read_local",
    description: "Inspect short-term episodes and explicit long-term memory claims.",
    requires_memory: true,
    agent_tool: {
      name: "moondog_memory_recall",
      label: "Recall relevant memories",
    },
  },
  {
    id: "memory.remember",
    version: "1",
    state: "enabled",
    effect: "write_local",
    description:
      "Persist a durable general fact, relationship preference, constraint, or goal explicitly stated by the user.",
    requires_memory: true,
    agent_tool: {
      name: "moondog_memory_remember",
      label: "Remember an explicit user memory",
    },
  },
  {
    id: "memory.forget",
    version: "1",
    state: "enabled",
    effect: "write_local",
    description: "Forget one explicit long-term memory when the user directly requests it.",
    requires_memory: true,
    agent_tool: {
      name: "moondog_memory_forget",
      label: "Forget an explicit memory",
    },
  },
  {
    id: "spotify.history.import",
    version: "1",
    state: "enabled",
    effect: "write_local",
    description:
      "Import Spotify Account Data or Extended Streaming History into private local music records.",
  },
  {
    id: "spotify.player.status",
    version: "1",
    state: "enabled",
    effect: "read_external",
    description: "Inspect metadata-free Spotify playback state.",
    requires_spotify: true,
    agent_tool: {
      name: "moondog_spotify_player_status",
      label: "Inspect Spotify playback",
    },
  },
  {
    id: "spotify.player.control",
    version: "1",
    state: "enabled",
    effect: "write_external",
    description: "Control the active Spotify player after a direct user request.",
    requires_spotify: true,
    agent_tool: {
      name: "moondog_spotify_player_control",
      label: "Control Spotify playback",
    },
  },
  {
    id: "spotify.queue.add",
    version: "1",
    state: "enabled",
    effect: "write_external",
    description: "Add one explicit Spotify URI to the playback queue.",
    requires_spotify: true,
    agent_tool: {
      name: "moondog_spotify_queue_add",
      label: "Add to Spotify queue",
    },
  },
  {
    id: "spotify.device.transfer",
    version: "1",
    state: "enabled",
    effect: "write_external",
    description: "Transfer Spotify playback to an explicit device ID.",
    requires_spotify: true,
    agent_tool: {
      name: "moondog_spotify_device_transfer",
      label: "Transfer Spotify playback",
    },
  },
  {
    id: "spotify.catalog.resolve",
    version: "1",
    state: "enabled",
    effect: "read_external",
    description:
      "Resolve trusted library tracks to deterministic Spotify catalog identities.",
    requires_spotify: true,
    requires_playlist_services: true,
    agent_tool: {
      name: "moondog_spotify_resolve_tracks",
      label: "Resolve library tracks on Spotify",
    },
  },
  {
    id: "spotify.library.check",
    version: "1",
    state: "enabled",
    effect: "read_external",
    description: "Check whether resolved tracks are already saved in the Spotify library.",
    requires_spotify: true,
    requires_playlist_services: true,
    agent_tool: {
      name: "moondog_spotify_library_check",
      label: "Check Spotify saved tracks",
    },
  },
  {
    id: "spotify.library.save",
    version: "1",
    state: "enabled",
    effect: "write_external",
    description: "Save explicitly requested resolved tracks to the Spotify library.",
    requires_spotify: true,
    requires_playlist_services: true,
    agent_tool: {
      name: "moondog_spotify_library_save",
      label: "Save tracks to Spotify library",
    },
  },
  {
    id: "spotify.playlist.read",
    version: "1",
    state: "enabled",
    effect: "read_external",
    description:
      "List and inspect owned private Spotify playlists through prompt-local opaque references.",
    requires_spotify: true,
    agent_tool: {
      name: "moondog_spotify_playlist_read",
      label: "Inspect Spotify playlists",
    },
  },
  {
    id: "spotify.playlist.edit.preview",
    version: "1",
    state: "enabled",
    effect: "derive_local",
    description:
      "Preview an exact existing-playlist rewrite without changing Spotify.",
    requires_spotify: true,
    agent_tool: {
      name: "moondog_spotify_playlist_edit_preview",
      label: "Preview Spotify playlist edit",
    },
  },
  {
    id: "spotify.playlist.edit.apply",
    version: "1",
    state: "enabled",
    effect: "write_external",
    description:
      "Apply the exact host-retained Spotify playlist edit after later explicit confirmation.",
    requires_spotify: true,
    agent_tool: {
      name: "moondog_spotify_playlist_edit_apply",
      label: "Apply Spotify playlist edit",
    },
  },
  {
    id: "spotify.playlist.write",
    version: "1",
    state: "enabled",
    effect: "write_external",
    description:
      "Create one private Spotify playlist from the exact validated playlist plan explicitly requested by the user.",
    requires_spotify: true,
    requires_playlist_services: true,
    agent_tool: {
      name: "moondog_spotify_playlist_write",
      label: "Write playlist to Spotify",
    },
  },
  {
    id: "music.generate",
    version: "1",
    state: "disabled",
    effect: "spend_and_write_external",
    description: "Call a music generation provider.",
  },
  {
    id: "gateway.openclaw",
    version: "1",
    state: "deferred",
    effect: "external_ingress_and_delivery",
    description: "Expose Moondog through OpenClaw and Telegram.",
  },
];

function withRuntimeAvailability(
  capability,
  domainServicesReady,
  profileServicesReady,
  playlistServicesReady,
  rediscoveryReady,
  historicalReturnReady,
  timeCapsuleReady,
  backToBackReady,
  memoryReady,
  spotifyReady,
  musicCatalogReady,
  musicDiscoveryReady,
  musicSimilarityReady,
  webResearchReady,
) {
  if (capability.requires_web_research && !webResearchReady) {
    return { ...capability, state: "blocked", blocked_by: "codex_web_not_ready" };
  }
  if (capability.requires_domain_services && !domainServicesReady) {
    return {
      ...capability,
      state: "blocked",
      blocked_by: "agent_domain_services_not_ready",
    };
  }
  if (capability.requires_profile_services && !profileServicesReady) {
    return {
      ...capability,
      state: "blocked",
      blocked_by: "profile_services_not_ready",
    };
  }
  if (capability.requires_playlist_services && !playlistServicesReady) {
    return {
      ...capability,
      state: "blocked",
      blocked_by: "playlist_services_not_ready",
    };
  }
  if (capability.requires_rediscovery_services && !rediscoveryReady) {
    return {
      ...capability,
      state: "blocked",
      blocked_by: "listening_history_rediscovery_not_ready",
    };
  }
  if (
    capability.requires_historical_return_services &&
    !historicalReturnReady
  ) {
    return {
      ...capability,
      state: "blocked",
      blocked_by: "listening_history_historical_returns_not_ready",
    };
  }
  if (capability.requires_time_capsule_services && !timeCapsuleReady) {
    return {
      ...capability,
      state: "blocked",
      blocked_by: "listening_history_time_capsule_not_ready",
    };
  }
  if (capability.requires_back_to_back_services && !backToBackReady) {
    return {
      ...capability,
      state: "blocked",
      blocked_by: "listening_history_back_to_back_not_ready",
    };
  }
  if (capability.requires_memory && !memoryReady) {
    return {
      ...capability,
      state: "blocked",
      blocked_by: "persistent_memory_not_ready",
    };
  }
  if (capability.requires_spotify && !spotifyReady) {
    return {
      ...capability,
      state: "blocked",
      blocked_by: "spotify_connection_not_ready",
    };
  }
  if (capability.requires_music_catalog && !musicCatalogReady) {
    return {
      ...capability,
      state: "blocked",
      blocked_by: "music_catalog_not_ready",
    };
  }
  if (capability.requires_music_discovery && !musicDiscoveryReady) {
    return {
      ...capability,
      state: "blocked",
      blocked_by: "music_discovery_not_ready",
    };
  }
  if (capability.requires_music_similarity && !musicSimilarityReady) {
    return {
      ...capability,
      state: "blocked",
      blocked_by: "music_similarity_not_ready",
    };
  }
  return capability;
}

export function listCapabilities({
  domainServicesReady = false,
  profileServicesReady = domainServicesReady,
  playlistServicesReady = domainServicesReady,
  rediscoveryReady = false,
  historicalReturnReady = false,
  timeCapsuleReady = false,
  backToBackReady = false,
  memoryReady = false,
  spotifyReady = false,
  musicCatalogReady = false,
  musicDiscoveryReady = false,
  musicSimilarityReady = false,
  webResearchReady = false,
} = {}) {
  return structuredClone(
    catalog.map((capability) =>
      withRuntimeAvailability(
        capability,
        domainServicesReady,
        profileServicesReady,
        playlistServicesReady,
        rediscoveryReady,
        historicalReturnReady,
        timeCapsuleReady,
        backToBackReady,
        memoryReady,
        spotifyReady,
        musicCatalogReady,
        musicDiscoveryReady,
        musicSimilarityReady,
        webResearchReady,
      ),
    ),
  );
}

export function listAgentCapabilityDescriptors(options = {}) {
  return listCapabilities(options)
    .filter(
      (capability) =>
        capability.state === "enabled" && capability.agent_tool,
    )
    .map((capability) => ({
      capability_id: capability.id,
      capability_version: capability.version,
      effect: capability.effect,
      tool_name: capability.agent_tool.name,
      label: capability.agent_tool.label,
    }));
}

export function getAgentCapabilityByToolName(toolName, options = {}) {
  return (
    listAgentCapabilityDescriptors(options).find(
      (capability) => capability.tool_name === toolName,
    ) ?? null
  );
}
