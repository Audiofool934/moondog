export function sanitizeTerminalText(value) {
  return String(value)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gi, "");
}

function words(value) {
  return String(value ?? "unknown").replaceAll("_", " ");
}

function formatSource(source) {
  if (!source.latest) return "- Apple Music library: not imported";
  return [
    `- Apple Music library: ${formatInteger(source.latest.tracks)} tracks and ${formatInteger(source.latest.playlists)} playlists, as of ${String(source.latest.captured_at).slice(0, 10)}`,
    source.semantics?.complete_listening_history_available
      ? "- Includes a full listening history"
      : "- A library shows what you keep, not every play",
  ].join("\n");
}

const serviceNames = {
  spotify: "Spotify",
  listenbrainz: "ListenBrainz",
  lastfm: "Last.fm",
  apple_music: "Apple Music",
  youtube_music: "YouTube Music",
  qq_music: "QQ Music",
  netease: "NetEase Cloud Music",
};

function formatProfile(profile) {
  if (profile.state !== "ready") {
    return `- Not ready yet${profile.reason ? `: ${profile.reason}` : ""}\n- \`/import\` brings in your history`;
  }
  const lines = [];
  const listening = [
    Number.isInteger(profile.effective_listening_events)
      ? `${formatInteger(profile.effective_listening_events)} ${profile.effective_listening_events === 1 ? "play" : "plays"}`
      : null,
    typeof profile.listening_hours === "number" && profile.listening_hours > 0 ? `${profile.listening_hours} h` : null,
    Array.isArray(profile.listening_sources) && profile.listening_sources.length > 0
      ? `from ${profile.listening_sources.map((source) => serviceNames[source] ?? words(source)).join(", ")}`
      : null,
  ].filter(Boolean);
  if (listening.length > 0) lines.push(`- ${listening.join(" · ")}`);
  if (Number.isInteger(profile.spotify_profile_evidence) && profile.spotify_profile_evidence > 0) {
    lines.push(`- ${formatInteger(profile.spotify_profile_evidence)} saved songs, follows, and playlist entries from Spotify`);
  }
  return lines.join("\n");
}

function safeInlineText(value) {
  return sanitizeTerminalText(value ?? "")
    .replace(/\\/gu, "\\\\")
    .replace(/([`*_[\]<>])/gu, "\\$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function formatInteger(value) {
  return Number.isInteger(value) ? value.toLocaleString("en-US") : "unknown";
}

function formatListeningTime(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return "unknown duration";
  if (minutes < 120) return `${Math.round(minutes)} min`;
  return `${Math.round((minutes / 60) * 10) / 10} h`;
}

function plural(value, one, many = `${one}s`) {
  return `${formatInteger(value)} ${value === 1 ? one : many}`;
}

function formatArtistSignal(item) {
  const details = [];
  if (Number.isInteger(item.play_count)) {
    details.push(plural(item.play_count, "play"));
  }
  if (Number.isFinite(item.listening_minutes)) {
    details.push(formatListeningTime(item.listening_minutes));
  }
  if (Number.isInteger(item.distinct_tracks)) {
    details.push(plural(item.distinct_tracks, "track"));
  }
  return `- ${safeInlineText(item.name)}${
    details.length > 0 ? ` · ${details.join(", ")}` : ""
  }`;
}

function formatTrackSignal(item) {
  const label = safeInlineText(item.label);
  const artist = safeInlineText(item.artist_credit);
  const details = [];
  if (Number.isInteger(item.play_count)) {
    details.push(plural(item.play_count, "play"));
  }
  if (Number.isFinite(item.listening_minutes)) {
    details.push(formatListeningTime(item.listening_minutes));
  }
  return `- ${label}${artist ? ` - ${artist}` : ""}${
    details.length > 0 ? ` · ${details.join(", ")}` : ""
  }`;
}

// Attention alone is the default reading, so only stronger evidence is worth naming.
const signalPhrases = {
  "historical attention only": null,
  "saved-library state": "saved in your library",
  "private playlist curation": "on one of your playlists",
  "explicit listener preference": "you said you like it",
};

function signalPhrase(value) {
  const text = safeInlineText(value);
  if (!text) return null;
  return Object.hasOwn(signalPhrases, text) ? signalPhrases[text] : text;
}

function withDetails(base, details) {
  const present = details.filter(Boolean);
  return `${base}${present.length > 0 ? ` · ${present.join(", ")}` : ""}`;
}

function formatRediscoveryTrack(item) {
  return withDetails(formatTrackSignal(item), [
    Number.isInteger(item.quiet_days)
      ? `quiet for ${plural(item.quiet_days, "day")}`
      : null,
    Number.isInteger(item.peak_year) ? `biggest in ${item.peak_year}` : null,
    signalPhrase(item.rediscovery_signal),
  ]);
}

function formatHistoricalReturnTrack(item) {
  return withDetails(formatTrackSignal(item), [
    Number.isInteger(item.return_count)
      ? `came back ${item.return_count === 1 ? "once" : `${formatInteger(item.return_count)} times`}`
      : null,
    Number.isInteger(item.longest_gap_days)
      ? `longest time away ${plural(item.longest_gap_days, "day")}`
      : null,
    signalPhrase(item.historical_return_signal),
  ]);
}

function formatBackToBackTrack(item) {
  return withDetails(formatTrackSignal(item), [
    Number.isInteger(item.maximum_consecutive_plays)
      ? `up to ${formatInteger(item.maximum_consecutive_plays)} in a row`
      : null,
    Number.isInteger(item.burst_count) && item.burst_count > 1
      ? `${formatInteger(item.burst_count)} separate runs`
      : null,
  ]);
}

function formatTimeCapsuleTrack(item) {
  const label = safeInlineText(item.label);
  const artist = safeInlineText(item.artist_credit);
  return withDetails(
    `- ${Number.isInteger(item.capsule_year) ? item.capsule_year : "Unknown year"}  ${label}${artist ? ` - ${artist}` : ""}`,
    [
      Number.isInteger(item.year_play_count)
        ? `${plural(item.year_play_count, "play")} that year`
        : null,
      signalPhrase(item.representative_signal),
    ],
  );
}

function formatHistoryArc(item) {
  const details = [];
  if (Number.isFinite(item.listening_minutes)) {
    details.push(formatListeningTime(item.listening_minutes));
  }
  if (Number.isInteger(item.event_count)) {
    details.push(plural(item.event_count, "play"));
  }
  if (Number.isInteger(item.distinct_tracks)) {
    details.push(plural(item.distinct_tracks, "track"));
  }
  if (Number.isInteger(item.first_observed_tracks) && item.first_observed_tracks > 0) {
    details.push(`${formatInteger(item.first_observed_tracks)} new`);
  }
  const topArtist = safeInlineText(item.top_artist?.name);
  if (topArtist) details.push(`mostly ${topArtist}`);
  return `- ${Number.isInteger(item.year) ? item.year : "Unknown year"}${
    details.length > 0 ? ` · ${details.join(", ")}` : ""
  }`;
}

function formatListeningSeason(item) {
  const key = safeInlineText(item.key).replace("-", " ");
  if (!Number.isInteger(item.event_count) || item.event_count === 0) {
    return `- ${key || "Unknown season"} · nothing in your history`;
  }
  const signature = safeInlineText(item.signature_track?.label);
  const signatureArtist = safeInlineText(item.signature_track?.artist_credit);
  return withDetails(`- ${key || "Unknown season"}`, [
    Number.isFinite(item.listening_minutes)
      ? formatListeningTime(item.listening_minutes)
      : null,
    plural(item.event_count, "play"),
    Number.isInteger(item.first_observed_tracks) && item.first_observed_tracks > 0
      ? `${formatInteger(item.first_observed_tracks)} new`
      : null,
    safeInlineText(item.leading_artist?.name)
      ? `mostly ${safeInlineText(item.leading_artist.name)}`
      : null,
    signature
      ? `top song ${signature}${signatureArtist ? ` - ${signatureArtist}` : ""}`
      : null,
  ]);
}

function formatListenerAssertion(item) {
  const label = safeInlineText(item.label);
  const artist = safeInlineText(item.artist_credit);
  const target = artist ? `${label} - ${artist}` : label;
  const note = safeInlineText(item.note);
  const entity = safeInlineText(item.entity_type);
  return `- ${item.stance === "avoid" ? "Keep out" : "Like"}${entity ? ` (${entity})` : ""}: ${target}${
    note ? ` · "${note}"` : ""
  } · ${safeInlineText(item.correction_id)}`;
}

function appendTasteSection(lines, title, values, formatter, subtitle) {
  if (!Array.isArray(values) || values.length === 0) return;
  lines.push("", `## ${title}`, "", ...(subtitle ? [`*${subtitle}*`, ""] : []), ...values.map(formatter));
}

function formatBehaviorContextLine(value, total, label) {
  if (!Number.isInteger(value) || total === 0) return null;
  const validTotal = Number.isInteger(total) && total >= value && total > 0;
  if (!validTotal) return `- ${label}: ${formatInteger(value)}`;
  const share = Math.round((value / total) * 100);
  return `- ${label}: ${share}% (${formatInteger(value)} of ${formatInteger(total)})`;
}

function formatTaste(profile) {
  const coverage = profile.coverage ?? {};
  const durationUnavailable = coverage.events_with_played_duration === 0;
  const listeningSignal = (formatter) => (item) => formatter(durationUnavailable ? { ...item, listening_minutes: undefined } : item);
  const behavior = profile.listening_behavior ?? {};
  const context = behavior.context ?? {};
  const listeningRange = profile.listening_source?.listening_range;
  const range =
    typeof listeningRange?.earliest === "string" &&
    typeof listeningRange?.latest === "string"
      ? `${listeningRange.earliest.slice(0, 10)} to ${listeningRange.latest.slice(0, 10)}`
      : null;
  const oneOff = profile.preview_source?.persistent_import === false;
  const hours = !durationUnavailable && Number.isFinite(coverage.listening_hours)
    ? `${coverage.listening_hours.toLocaleString("en-US")} h`
    : null;
  const lines = [
    "# Your listening, so far",
    "",
    oneOff
      ? "A one-off reading of the file you chose. Nothing was saved to your profile."
      : "Read from your own files. It stays on this machine.",
    "",
    "## What I'm reading from",
    "",
  ];
  const summary = [
    Number.isInteger(coverage.effective_listening_events) ? plural(coverage.effective_listening_events, "play") : null,
    hours,
    Number.isInteger(coverage.listening_tracks) ? plural(coverage.listening_tracks, "track") : null,
  ].filter(Boolean);
  if (summary.length > 0) lines.push(`- ${summary.join(" · ")}`);
  if (range) lines.push(`- ${range}`);
  const saved = coverage.saved_tracks ?? coverage.spotify_saved_tracks;
  if (Number.isInteger(saved) && saved > 0) lines.push(`- ${plural(saved, "saved track")}`);
  const memberships = coverage.playlist_memberships ?? coverage.spotify_playlist_memberships;
  if (Number.isInteger(memberships) && memberships > 0) lines.push(`- ${plural(memberships, "song", "songs")} on your playlists`);
  for (const source of coverage.collection_sources ?? []) {
    if (source.tracks > 0) lines.push(`- ${safeInlineText(source.label)}: ${plural(source.tracks, "track")}`);
  }
  if (!durationUnavailable && Number.isInteger(coverage.events_with_played_duration) &&
    Number.isInteger(coverage.effective_listening_events) &&
    coverage.events_with_played_duration < coverage.effective_listening_events) {
    lines.push(`- Listening time is known for ${formatInteger(coverage.events_with_played_duration)} of those plays`);
  }
  if (Number.isInteger(coverage.cross_format_track_links) && coverage.cross_format_track_links > 0) {
    lines.push(`- ${plural(coverage.cross_format_track_links, "track")} matched across your two Spotify exports`);
  }
  if (Number.isInteger(coverage.cross_format_ambiguous_tracks) && coverage.cross_format_ambiguous_tracks > 0) {
    lines.push(`- ${plural(coverage.cross_format_ambiguous_tracks, "track")} kept apart because the match was unclear`);
  }
  if (Number.isInteger(context.incognito_events_excluded) && context.incognito_events_excluded > 0) {
    lines.push(`- ${plural(context.incognito_events_excluded, "private-session play")} left out`);
  }

  appendTasteSection(
    lines,
    "What you told me",
    profile.listener_assertions?.active,
    formatListenerAssertion,
  );
  appendTasteSection(
    lines,
    "Shine On",
    behavior.enduring_artists,
    listeningSignal(formatArtistSignal),
    "Artists who stayed with you across the years",
  );
  appendTasteSection(
    lines,
    "Lately",
    behavior.recent_artists,
    listeningSignal(formatArtistSignal),
    Number.isInteger(context.recent_window_days)
      ? `Who you've played most in the last ${context.recent_window_days} days`
      : "Who you've played most recently",
  );
  appendTasteSection(
    lines,
    "Year by year",
    behavior.history_arc,
    listeningSignal(formatHistoryArc),
  );
  const listeningSeasons = behavior.listening_seasons?.seasons;
  appendTasteSection(
    lines,
    "Seasons",
    Array.isArray(listeningSeasons) ? listeningSeasons.slice(-12) : [],
    listeningSignal(formatListeningSeason),
    "Your last twelve quarters. \"New\" means new to your history, not necessarily new to you.",
  );
  appendTasteSection(
    lines,
    "Time",
    behavior.time_capsule_tracks,
    formatTimeCapsuleTrack,
    "The years, one track each",
  );
  appendTasteSection(
    lines,
    "Wish You Were Here",
    behavior.rediscovery_tracks,
    formatRediscoveryTrack,
    Number.isInteger(context.rediscovery_quiet_days)
      ? `Songs you used to play a lot that have gone quiet for ${context.rediscovery_quiet_days}+ days`
      : "Songs you used to play a lot that have gone quiet",
  );
  appendTasteSection(
    lines,
    "Coming Back to Life",
    behavior.historical_return_tracks,
    formatHistoricalReturnTrack,
    Number.isInteger(context.historical_return_minimum_gap_days)
      ? `Songs that found their way back after ${context.historical_return_minimum_gap_days}+ days away`
      : "Songs that found their way back after long gaps",
  );
  appendTasteSection(
    lines,
    "Echoes",
    behavior.back_to_back_tracks,
    formatBackToBackTrack,
    "Songs you played again right away",
  );
  appendTasteSection(
    lines,
    "Most played",
    behavior.repeat_tracks,
    listeningSignal(formatTrackSignal),
  );
  appendTasteSection(
    lines,
    "Recently",
    behavior.recent_tracks,
    listeningSignal(formatTrackSignal),
  );

  const behaviorContextLines = [
    formatBehaviorContextLine(context.direct_selection_starts, context.start_reason_events, "Songs you picked yourself"),
    formatBehaviorContextLine(context.trackdone_starts, context.start_reason_events, "Songs that followed on"),
    formatBehaviorContextLine(context.trackdone_endings, context.end_reason_events, "Played to the end"),
    formatBehaviorContextLine(context.explicit_skips, context.skip_state_events, "Skipped"),
    formatBehaviorContextLine(context.shuffle_events, context.shuffle_state_events, "On shuffle"),
    formatBehaviorContextLine(context.offline_events, context.offline_state_events, "Offline"),
  ].filter(Boolean);
  if (behaviorContextLines.length > 0) {
    lines.push("", "## How you listen", "", ...behaviorContextLines);
  }

  if (
    Array.isArray(profile.strong_preferences) &&
    profile.strong_preferences.length > 0
  ) {
    lines.push(
      "",
      "## Kept on purpose",
      "",
      ...profile.strong_preferences.map(
        (item) =>
          `- ${safeInlineText(item.label)} · ${safeInlineText(item.signal).toLowerCase()}`,
      ),
    );
  }

  lines.push(
    "",
    "## The dark side of the moon",
    "",
    "*What this reading can't see*",
    "",
    "- Plays show attention, not love. A song can be on repeat because it was stuck in your head.",
    ...(behaviorContextLines.length > 0 ? ["- A skip is a moment, not a verdict."] : []),
    ...((behavior.history_arc ?? []).length > 0 || (listeningSeasons ?? []).length > 0
      ? ["- Years and seasons follow UTC, so a late night can land on the next day.",
        "- A quiet stretch means no history was kept, not that you stopped listening."]
      : []),
    "- If something here is wrong, open the song or artist in /taste and tell me.",
    "",
    oneOff
      ? "Add `--json` to the same `--from` command for the full data."
      : "For the full data with evidence IDs, run `moondog taste --json`.",
  );
  return lines.join("\n");
}

function formatMemory(memory) {
  const lines = [];
  if (Number.isInteger(memory.sessions)) {
    lines.push(
      `- ${formatInteger(memory.sessions)} ${memory.sessions === 1 ? "conversation" : "conversations"} saved on this machine`,
      `- ${formatInteger(memory.active_memories)} ${memory.active_memories === 1 ? "thing" : "things"} I remember about you`,
    );
    if (memory.reflection?.pending_episodes > 0) {
      lines.push(`- ${formatInteger(memory.reflection.pending_episodes)} recent moments I haven't thought over yet`);
    }
  } else {
    lines.push(`- ${words(memory.state)}`);
  }
  lines.push(
    "",
    "I keep what you tell me in conversation apart from your music profile.",
    "I only remember something for good when you say it plainly, or when you ask with `/remember`.",
    "`/forget <id>` removes it.",
  );
  if (Array.isArray(memory.memories) && memory.memories.length > 0) {
    lines.push(
      "",
      "## What I remember",
      "",
      ...memory.memories.map((entry) => `- ${entry.text} · ${entry.kind} · \`${entry.memory_id}\``),
    );
  }
  if (Array.isArray(memory.recent_episodes) && memory.recent_episodes.length > 0) {
    lines.push(
      "",
      "## Lately",
      "",
      ...memory.recent_episodes.map((episode) => `- ${String(episode.occurred_at).slice(0, 10)} · ${episode.summary}`),
    );
  }
  if (Array.isArray(memory.recent_sessions) && memory.recent_sessions.length > 0) {
    lines.push(
      "",
      "## Recent conversations",
      "",
      ...memory.recent_sessions.map((session) => {
        const userTurns = session.turns
          .filter((turn) => turn.role === "user")
          .map((turn) => turn.text)
          .join(" / ");
        return `- ${String(session.started_at).slice(0, 10)} · ${userTurns}`;
      }),
    );
  }
  return lines.join("\n");
}

function formatReflectionProposal(proposal) {
  const evidence = proposal.episode_ids.map((id) => `\`${id}\``).join(", ");
  if (proposal.action === "candidate_memory") {
    return `- [memory/${proposal.assertion_mode}/${proposal.confidence}] ${proposal.statement}\n  Evidence: ${evidence}\n  Why: ${proposal.rationale}`;
  }
  if (proposal.action === "candidate_music_profile") {
    return `- [music-profile/${proposal.direction}/${proposal.confidence}] ${proposal.dimension}: ${proposal.value}\n  Evidence: ${evidence}\n  Why: ${proposal.rationale}`;
  }
  return `- [ignore] ${proposal.reason}\n  Episodes: ${evidence}`;
}

export function formatMemoryReflection(value) {
  if (value.state === "no_work") {
    return "Memory Agent: no unprocessed episodes.";
  }
  if (value.state === "busy") {
    return `Memory Agent: another reflection is running (${value.active_run?.run_id ?? "unknown"}).`;
  }
  const counts = value.counts ?? {};
  const dryRun = value.state === "dry_run";
  const lines = [
    `# Memory reflection ${value.state}`,
    "",
    `- Run: \`${value.run_id}\``,
    `- Proposals: ${counts.proposals ?? value.proposals?.length ?? 0}`,
    `- ${dryRun ? "Would promote durable memories" : "Durable memories promoted"}: ${counts.promoted_memories ?? 0}`,
    `- ${dryRun ? "Would create durable memories" : "New durable memories"}: ${counts.created_memories ?? 0}`,
    `- ${dryRun ? "Would become candidate episodes" : "Candidate episodes"}: ${counts.candidate_episodes ?? 0}`,
    `- ${dryRun ? "Would ignore episodes" : "Ignored episodes"}: ${counts.ignored_episodes ?? 0}`,
  ];
  if (Array.isArray(value.proposals) && value.proposals.length > 0) {
    lines.push(
      "",
      "## Decisions",
      "",
      ...value.proposals.map(formatReflectionProposal),
    );
  }
  return lines.join("\n");
}

export function formatDemoResult(value) {
  const lines = [
    "# Moondog demo",
    "",
    "This walkthrough uses synthetic music data and has no music-service side effects.",
    "",
    "## Prompt",
    "",
    safeInlineText(value.prompt),
    "",
    "## Tool trace",
    "",
  ];
  if (Array.isArray(value.tool_trace) && value.tool_trace.length > 0) {
    lines.push(
      ...value.tool_trace.map(
        (entry) =>
          `${entry.sequence}. ${safeInlineText(entry.capability)} - ${safeInlineText(entry.status)}`,
      ),
    );
  } else {
    lines.push("No tools were called.");
  }
  lines.push("", "## Result", "", value.result?.text ?? "No result text.");
  if (Array.isArray(value.limitations) && value.limitations.length > 0) {
    lines.push(
      "",
      "## Boundaries",
      "",
      ...value.limitations.map(
        (limitation) => `- ${safeInlineText(limitation)}`,
      ),
    );
  }
  if (Array.isArray(value.next_steps) && value.next_steps.length > 0) {
    lines.push("", "## Keep exploring", "");
    for (const step of value.next_steps) {
      lines.push(
        `### ${safeInlineText(step.title)}`,
        "",
        `- From this checkout: \`${safeInlineText(step.checkout_command)}\``,
        `- From an installed CLI: \`${safeInlineText(step.installed_command)}\``,
        `- ${safeInlineText(step.data_boundary)}`,
      );
    }
  }
  return lines.join("\n");
}

const capabilityStates = {
  ready: "ready",
  enabled: "ready",
  available: "ready",
  blocked: "not available yet",
  unavailable: "not available",
  disabled: "off",
};

function formatTools(value) {
  const rows = value.capabilities.map((capability) => {
    const label = capability.agent_tool?.label ?? capability.id;
    const state = capabilityStates[capability.state] ?? words(capability.state);
    return `- **${label}** · ${state}\n  ${capability.description}${
      capability.blocked_by ? `\n  Waiting on: ${words(capability.blocked_by)}` : ""
    }`;
  });
  return `# What I can do\n\n${rows.join("\n")}`;
}

const doctorLabels = {
  "web.codex_cli": "Web lookups (Codex CLI)",
  "node.version": "Node.js",
  "apple_music.source": "Apple Music library",
  "profile.projection": "Listening profile",
  "agent.runtime": "Model",
  "music.discovery.open_similarity": "Finding similar music",
  "external.effects": "Changes to your accounts",
  "spotify.connection": "Spotify",
  "spotify.connected_action_scopes": "Spotify permissions",
};

function formatDoctor(value) {
  return [
    "# Checkup",
    "",
    ...value.checks.map((check) => {
      const state = check.ok ? "ok" : check.optional_for_local_commands ? "not set up (optional)" : "not working";
      const detail = words(check.actual ?? check.state ?? "unknown");
      return `- ${doctorLabels[check.id] ?? check.id}: ${state} · ${detail}`;
    }),
  ].join("\n");
}

function formatRuntime(runtime) {
  if (runtime?.state === "configured") {
    return `- Talking through ${runtime.provider && runtime.model ? `\`${runtime.provider}/${runtime.model}\`` : "your chosen model"}`;
  }
  return runtime?.reason === "provider_authentication_required"
    ? "- Not signed in yet. `/auth` fixes that."
    : "- No model connected. `/model` picks one. Your profile works without it.";
}

function formatSpotifyStatus(spotify) {
  const state = spotify?.state ?? "not_configured";
  if (state === "ready" || state === "connected") return "- Connected";
  return state === "not_configured"
    ? "- Not connected. `/import` > Spotify walks you through it."
    : `- ${words(state)}`;
}

export function formatLocalResult(command, value) {
  switch (command) {
    case "status":
    case "sources":
      return [
        "# Where things stand",
        "",
        "## Your profile",
        "",
        formatProfile(value.profile),
        formatSource(value.source),
        "",
        "## Talking",
        "",
        formatRuntime(value.runtime),
        "",
        "## Memory",
        "",
        formatMemory(value.memory),
        "",
        "## Spotify",
        "",
        formatSpotifyStatus(value.spotify),
        "",
        value.external_effects === "disabled" && (value.spotify?.external_effects ?? "disabled") === "disabled"
          ? "Right now I can't change anything in your music accounts."
          : "I can make changes in your connected accounts, and I always ask first.",
      ].join("\n");
    case "profile":
      return `# Your profile\n\n${formatProfile(value)}`;
    case "taste":
      return formatTaste(value);
    case "memory":
      return `# What I remember\n\n${formatMemory(value)}`;
    case "tools":
      return formatTools(value);
    case "doctor":
      return formatDoctor(value);
    default:
      return JSON.stringify(value, null, 2);
  }
}

export function helpText() {
  return `# Every command

From your shell:

- \`moondog web status|search|read [arguments] [--json]\` - look things up on public music sites through the Codex CLI
- \`moondog studio\` - open the browser Studio for dropping in a Spotify ZIP
- \`moondog studio --demo\` - try the Studio with made-up history; your own data is never read
- \`moondog studio --from <spotify-history.zip>\` - look at one Spotify ZIP in the Studio without saving it
- \`moondog studio --from <account-data.zip> --from <extended-history.zip>\` - combine two Spotify ZIPs in the Studio without saving them
- \`moondog demo-history --output <absolute-file.zip> [--json]\` - make a fictional Spotify history ZIP to try the importer with
- \`moondog auth login <provider>\` - sign in to a model provider; the key is typed out of sight, and openai-codex uses your ChatGPT sign-in
- \`moondog auth status [provider]\` - see which sign-ins are saved
- \`moondog auth logout <provider>\` - sign out of a provider
- \`moondog spotify help\` - set up and control Spotify
- \`moondog spotify login [client-id]\` - connect Spotify in your browser
- \`moondog spotify now|devices|queue\` - see what Spotify is playing, where, and what's next
- \`moondog spotify recent\` - see what you played lately
- \`moondog spotify sync-recent\` - add your latest plays to your profile
- \`moondog spotify play|pause|next|previous\` - control Spotify playback
- \`moondog listenbrainz import-history <listen-history.json>\` - add a ListenBrainz listens file to your profile
- \`moondog catalog latest-single --artist <name> [--known-release <title> | --from <spotify-history.zip>]\` - find an artist's latest single on Apple Music (US), no model needed
- \`moondog status [--json]\` - see where things stand
- \`moondog taste [--json]\` - your listening report
- \`moondog taste --html [--output <file.html>]\` - save your report as a web page that works offline
- \`moondog taste --card [--output <file.html>]\` - save a short recap you can check before sharing
- \`moondog taste --from <spotify-history.zip> --html\` - a one-off report from a Spotify ZIP, without saving it
- \`moondog taste --from <account-data.zip> --from <extended-history.zip> --html\` - a one-off report from both Spotify exports together
- \`moondog taste --from <spotify-history.zip> --save --html\` - save the Spotify history, then show your full report
- \`moondog data inspect --scope <listening|apple|profile>\` - see what's stored, and get the code needed to reset it
- \`moondog data export --scope <listening|apple|profile> --output <directory>\` - export a copy, leaving the original alone
- \`moondog data reset --scope <listening|apple|profile> --confirm <token>\` - set stored data aside (it is archived, not deleted)
- \`moondog profile corrections [--all]\` - everything you've told me, including earlier choices
- \`moondog profile correct --artist <name> (--like|--avoid)\` - like an artist, or keep them out
- \`moondog profile correct --track <title> --by <artist> (--like|--avoid)\` - like a track, or keep it out
- \`moondog profile retract <correction-id>\` - undo one of your choices
- \`moondog demo --offline [--json]\` - a demo with made-up data, no sign-in needed
- \`moondog demo [prompt] [--json]\` - the same demo, talking through your model
- \`moondog ask <prompt>\` - ask one question and exit
- \`moondog remember <text>\` - ask me to remember something
- \`moondog forget <memory-id>\` - forget something
- \`moondog memory reflect [--dry-run] [--json]\` - let me think over recent conversations now
- \`moondog\` - open the listening room

Inside the listening room:

- \`/status\` or \`/sources\` - see where things stand
- \`/profile\` or \`/taste\` - your profile, and why each song or artist is there
- \`/taste report\` - the whole report on one page
- \`/profile corrections [--all]\` - everything you've told me
- \`/profile correct --track "<title>" --by "<artist>" (--like|--avoid)\` - like a track, or keep it out
- \`/profile correct --artist "<name>" (--like|--avoid)\` - like an artist, or keep them out
- \`/profile retract <correction-id>\` - undo a choice
- \`/memory\` - what I remember
- \`/tools\` - what I can do right now
- \`/doctor\` - check your setup
- \`/model\` - pick the model I talk through
- \`/model <provider> <model>\` - switch straight to a model
- \`/auth [provider]\` - sign in to a model provider
- \`/web status|search|read\` - look things up on public music sites
- \`/import [path]\` - bring in your history, library, or a playlist
- \`/spotify\` - Spotify commands
- \`/spotify login [client-id]\` - connect Spotify
- \`/spotify now|devices|queue\` - see what's playing, where, and what's next
- \`/spotify recent|sync-recent\` - see or save your latest plays
- \`/spotify import-history "/path/to/spotify-history.zip"\` - add a Spotify ZIP, no sign-in needed
- \`/reload\` - reload model settings and sign-ins
- \`/remember [kind] <text>\` - ask me to remember something
- \`/forget <memory-id>\` - forget something
- \`/resume\` - pick up a saved conversation
- \`/resume <session-id>\` - go straight to one
- \`/new\` - start fresh; the last one stays saved
- \`/quit\` - exit

Anything you type that isn't a command goes to the model you picked with \`/model\`, or the one set in \`MOONDOG_PROVIDER\` and \`MOONDOG_MODEL\`.
Sign in with \`/auth\`, or set the provider's API key in your environment. \`/auth openai-codex\` uses your ChatGPT sign-in.
Once your profile is ready, I can search your library, explain what I see, and plan playlists with you.
I can only control Spotify after \`moondog spotify login\`, and I never post, send messages, delete anything, or spend money.
Ask me to move playback onto a device by name, such as your iPhone.`;
}
