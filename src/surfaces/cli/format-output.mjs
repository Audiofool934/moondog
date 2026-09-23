function yesNo(value) {
  return value ? "yes" : "no";
}

export function sanitizeTerminalText(value) {
  return String(value)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gi, "");
}

function formatSource(source) {
  if (!source.latest) {
    return [
      `- Apple Music snapshot: ${source.state}`,
      "- Complete listening history: no",
    ].join("\n");
  }

  return [
    `- Apple Music snapshot: ${source.state}`,
    `- Imported tracks: ${source.latest.tracks}`,
    `- Imported playlists: ${source.latest.playlists}`,
    `- Aggregate track snapshots: ${source.latest.aggregate_track_snapshots}`,
    `- Snapshot captured at: ${source.latest.captured_at}`,
    `- Complete listening history: ${yesNo(
      source.semantics.complete_listening_history_available,
    )}`,
  ].join("\n");
}

function formatProfile(profile) {
  const lines = [
    `- State: ${profile.state}`,
    `- Evidence records: ${profile.evidence_records}`,
    `- Claims: ${profile.claims}`,
  ];
  if (profile.reason) lines.push(`- Why: ${profile.reason}`);
  if (profile.projection_version) {
    lines.push(`- Projection: ${profile.projection_version}`);
  }
  if (Number.isInteger(profile.effective_listening_events)) {
    lines.push(
      `- Effective listening events: ${profile.effective_listening_events}`,
    );
  }
  if (typeof profile.listening_hours === "number") {
    lines.push(`- Listening hours with supplied duration: ${profile.listening_hours}`);
  }
  if (Array.isArray(profile.listening_sources)) {
    lines.push(
      `- Listening sources: ${profile.listening_sources.length > 0 ? profile.listening_sources.join(", ") : "none"}`,
    );
  }
  if (Number.isInteger(profile.spotify_profile_evidence)) {
    lines.push(
      `- Spotify library, playlist, search, and provider evidence: ${profile.spotify_profile_evidence}`,
    );
  }
  if (Array.isArray(profile.next_contracts)) {
    lines.push(`- Next contracts: ${profile.next_contracts.join(", ")}`);
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
  const lines = [
    `- State: ${memory.state}`,
    `- Conversation transcript: ${memory.conversation_transcript}`,
    `- Long-term memory: ${memory.long_term_memory}`,
    `- Music profile is separate: ${yesNo(memory.music_profile_is_separate)}`,
    `- Policy: ${memory.policy}`,
  ];
  if (Number.isInteger(memory.sessions)) {
    lines.push(
      `- Sessions: ${memory.sessions}`,
      `- Persisted turns: ${memory.turns}`,
      `- Short-term episodes: ${memory.episodes}`,
      `- Active durable memories: ${memory.active_memories}`,
    );
  }
  if (memory.reflection) {
    lines.push(
      `- Memory Agent: ${memory.reflection.state}`,
      `- Episodes awaiting reflection: ${memory.reflection.pending_episodes}`,
      `- Profile or inferred candidates: ${memory.reflection.candidate_episodes}`,
    );
    if (memory.reflection.last_run) {
      lines.push(
        `- Last reflection: ${memory.reflection.last_run.status} at ${memory.reflection.last_run.started_at}`,
      );
    }
  }
  if (Array.isArray(memory.memories) && memory.memories.length > 0) {
    lines.push(
      "",
      "## Durable memories",
      "",
      ...memory.memories.map(
        (entry) => {
          const evidence = Array.isArray(entry.evidence_episode_ids)
            ? `\n  Evidence episodes: ${entry.evidence_episode_ids
                .map((id) => `\`${id}\``)
                .join(", ")}`
            : "";
          return `- \`${entry.memory_id}\` [${entry.kind}/${entry.horizon}] ${entry.text}${evidence}`;
        },
      ),
    );
  }
  if (
    Array.isArray(memory.recent_episodes) &&
    memory.recent_episodes.length > 0
  ) {
    lines.push(
      "",
      "## Recent episodes",
      "",
      ...memory.recent_episodes.map(
        (episode) =>
          `- ${episode.occurred_at} [${episode.kind}] ${episode.summary}`,
      ),
    );
  }
  if (
    Array.isArray(memory.recent_sessions) &&
    memory.recent_sessions.length > 0
  ) {
    lines.push(
      "",
      `## Recent conversations (${memory.recent_sessions.length})`,
      "",
      ...memory.recent_sessions.map((session) => {
        const userTurns = session.turns
          .filter((turn) => turn.role === "user")
          .map((turn) => turn.text)
          .join(" / ");
        return `- ${session.started_at}: ${userTurns}`;
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

function formatTools(value) {
  const rows = value.capabilities.map(
    (capability) =>
      `- \`${capability.id}\` - ${capability.state} - ${capability.effect}\n  ${capability.description}${
        capability.blocked_by
          ? `\n  Blocked by: ${capability.blocked_by}`
          : ""
      }${
        capability.agent_tool
          ? `\n  Agent capability: ${capability.agent_tool.label}`
          : ""
      }`,
  );
  return `# Capability registry\n\nVersion: ${value.registry_version}\n\n${rows.join(
    "\n",
  )}`;
}

function formatDoctor(value) {
  return [
    "# Doctor",
    "",
    ...value.checks.map((check) => {
      const state = check.ok ? "ok" : check.optional_for_local_commands ? "optional" : "failed";
      const detail = check.actual ?? check.state ?? "unknown";
      return `- ${check.id}: ${state} (${detail})`;
    }),
  ].join("\n");
}

export function formatLocalResult(command, value) {
  switch (command) {
    case "status":
    case "sources":
      return [
        `# Moondog ${value.milestone} status`,
        "",
        `- Client: ${value.client}`,
        `- Agent runtime: ${value.runtime.state}`,
        `- External effects: ${value.external_effects}`,
        "",
        "## Data source",
        "",
        formatSource(value.source),
        "",
        "## Profile",
        "",
        formatProfile(value.profile),
        "",
        "## Memory",
        "",
        formatMemory(value.memory),
        "",
        "## Spotify",
        "",
        `- State: ${value.spotify?.state ?? "not_configured"}`,
        `- External effects: ${value.spotify?.external_effects ?? "disabled"}`,
      ].join("\n");
    case "profile":
      return `# Profile\n\n${formatProfile(value)}`;
    case "taste":
      return formatTaste(value);
    case "memory":
      return `# Memory\n\n${formatMemory(value)}`;
    case "tools":
      return formatTools(value);
    case "doctor":
      return formatDoctor(value);
    default:
      return JSON.stringify(value, null, 2);
  }
}

export function helpText() {
  return `# Moondog CLI

Shell commands:

- \`moondog web status|search|read [arguments] [--json]\` - use the local Codex CLI for public web research
- \`moondog studio\` - open the private local drag-and-drop Spotify import Studio
- \`moondog studio --demo\` - run fictional history through the production importer and open its zero-data Time Machine without reading private history
- \`moondog studio --from <spotify-history.zip>\` - open one supplied Spotify history ZIP as a session-only private Tasteprint without persistent import
- \`moondog studio --from <account-data.zip> --from <extended-history.zip>\` - reconcile one or two supplied Spotify history ZIPs as a session-only private Tasteprint without persistent import
- \`moondog demo-history --output <absolute-file.zip> [--json]\` - generate deterministic fictional Spotify history for the real importer
- \`moondog auth login <provider>\` - save an API key with hidden input; openai-codex uses ChatGPT OAuth
- \`moondog auth status [provider]\` - inspect saved or environment credential metadata
- \`moondog auth logout <provider>\` - remove that provider's saved credential
- \`moondog spotify help\` - configure and control Spotify Connect
- \`moondog spotify login [client-id]\` - authorize Spotify with browser OAuth
- \`moondog spotify now|devices|queue\` - inspect Spotify player state
- \`moondog spotify recent\` - inspect bounded recent listening activity
- \`moondog spotify sync-recent\` - store recent plays as local provider-neutral records
- \`moondog spotify play|pause|next|previous\` - control Spotify playback
- \`moondog listenbrainz import-history <listen-history.json>\` - import an official saved ListenBrainz response or submission locally
- \`moondog catalog latest-single --artist <name> [--known-release <title> | --from <spotify-history.zip>]\` - read one dated Apple Music US answer without a model
- \`moondog status [--json]\` - inspect local data and runtime readiness
- \`moondog taste [--json]\` - view your private evidence-backed tasteprint
- \`moondog taste --html [--output <file.html>]\` - create a private no-network visual tasteprint
- \`moondog taste --card [--output <file.html>]\` - create a compact private recap for review before sharing
- \`moondog taste --from <spotify-history.zip> --html\` - create a one-off private Tasteprint without Apple setup or a persistent import
- \`moondog taste --from <account-data.zip> --from <extended-history.zip> --html\` - reconcile two distinct Spotify exports in memory for one complete private preview
- \`moondog taste --from <spotify-history.zip> --save --html\` - persist Spotify history and create a cumulative private Tasteprint without Apple setup
- \`moondog data inspect --scope <listening|apple|profile>\` - preview selected local music state and get an exact reset token
- \`moondog data export --scope <listening|apple|profile> --output <directory>\` - create a private checksummed snapshot without changing the source
- \`moondog data reset --scope <listening|apple|profile> --confirm <token>\` - archive selected local music state without deleting it
- \`moondog profile corrections [--all]\` - inspect active, superseded, and retracted listener corrections
- \`moondog profile correct --artist <name> (--like|--avoid)\` - record a retractable explicit artist stance
- \`moondog profile correct --track <title> --by <artist> (--like|--avoid)\` - record a retractable explicit track stance
- \`moondog profile retract <correction-id>\` - retract one active listener correction
- \`moondog demo --offline [--json]\` - run the zero-auth deterministic showcase
- \`moondog demo [prompt] [--json]\` - run a synthetic read-only Agent walkthrough with the configured model
- \`moondog ask <prompt>\` - run one configured model turn
- \`moondog remember <text>\` - save an explicit durable memory
- \`moondog forget <memory-id>\` - forget one durable memory
- \`moondog memory reflect [--dry-run] [--json]\` - run the one-shot background Memory Agent
- \`moondog\` - start the interactive TUI

Interactive slash commands:

- \`/status\` or \`/sources\` - inspect data and runtime readiness
- \`/profile\` or \`/taste\` - explore tracks and artists, inspect evidence, and adjust preferences
- \`/taste report\` - read the complete private Tasteprint and listening patterns
- \`/profile corrections [--all]\` - inspect active or previous listener corrections
- \`/profile correct --track "<title>" --by "<artist>" (--like|--avoid)\` - record an explicit track stance
- \`/profile correct --artist "<name>" (--like|--avoid)\` - record an explicit artist stance
- \`/profile retract <correction-id>\` - retract a correction and return to the refreshed profile
- \`/memory\` - inspect memory ownership and persistence
- \`/tools\` - inspect the capability registry
- \`/doctor\` - run local environment checks
- \`/model\` - choose and persist a Pi provider and model
- \`/model <provider> <model>\` - switch directly by ID
- \`/auth [provider]\` - connect a model API key or sign in to OpenAI Codex from the TUI
- \`/web status|search|read\` - research public music sources using the local Codex CLI
- \`/import [path]\` - get listening-data guidance or inspect a Spotify ZIP / ListenBrainz JSON before importing
- \`/spotify\` - show Spotify setup and control commands
- \`/spotify login [client-id]\` - authorize Spotify from the TUI
- \`/spotify now|devices|queue\` - inspect the current Spotify player
- \`/spotify recent|sync-recent\` - inspect or locally ingest bounded recent activity
- \`/spotify import-history "/path/to/spotify-history.zip"\` - import a saved archive locally without OAuth
- \`/reload\` - reload saved model settings and authentication
- \`/remember [kind] <text>\` - save an explicit durable memory
- \`/forget <memory-id>\` - forget one durable memory
- \`/resume\` - search recent saved conversations and choose one to continue
- \`/resume <session-id>\` - continue a saved conversation by ID
- \`/new\` - start a new conversation and keep the previous one saved
- \`/quit\` - exit

Free text is sent to the model selected with \`/model\` or the \`MOONDOG_PROVIDER\` and \`MOONDOG_MODEL\` environment overrides.
Use \`/auth [provider]\` or the provider's API key environment variable to connect.
The \`openai-codex\` provider uses ChatGPT OAuth with \`/auth openai-codex\`.
When the local projection is ready, the A1 runtime can search the imported library, inspect bounded profile evidence, and derive an in-memory playlist plan.
Spotify playback writes are enabled only after \`moondog spotify login\`. Publishing, messaging, deletion, and paid generation remain disabled.`;
}
