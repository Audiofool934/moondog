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

function formatArtistSignal(item) {
  const details = [];
  if (Number.isInteger(item.play_count)) {
    details.push(`${formatInteger(item.play_count)} plays`);
  }
  if (Number.isFinite(item.listening_minutes)) {
    details.push(formatListeningTime(item.listening_minutes));
  }
  if (Number.isInteger(item.distinct_tracks)) {
    details.push(`${formatInteger(item.distinct_tracks)} tracks`);
  }
  return `- ${safeInlineText(item.name)}${
    details.length > 0 ? ` - ${details.join(", ")}` : ""
  }`;
}

function formatTrackSignal(item) {
  const label = safeInlineText(item.label);
  const artist = safeInlineText(item.artist_credit);
  const details = [];
  if (Number.isInteger(item.play_count)) {
    details.push(`${formatInteger(item.play_count)} plays`);
  }
  if (Number.isFinite(item.listening_minutes)) {
    details.push(formatListeningTime(item.listening_minutes));
  }
  return `- ${label}${artist ? ` - ${artist}` : ""}${
    details.length > 0 ? ` - ${details.join(", ")}` : ""
  }`;
}

function formatRediscoveryTrack(item) {
  const base = formatTrackSignal(item);
  const details = [
    Number.isInteger(item.quiet_days)
      ? `${formatInteger(item.quiet_days)} days quiet`
      : null,
    Number.isInteger(item.peak_year)
      ? `strongest year ${item.peak_year}`
      : null,
    safeInlineText(item.rediscovery_signal)
      ? `basis: ${safeInlineText(item.rediscovery_signal)}`
      : null,
  ].filter(Boolean);
  return `${base}${details.length > 0 ? ` - ${details.join(", ")}` : ""}`;
}

function formatHistoricalReturnTrack(item) {
  const base = formatTrackSignal(item);
  const details = [
    Number.isInteger(item.return_count)
      ? `${formatInteger(item.return_count)} observed ${item.return_count === 1 ? "return" : "returns"}`
      : null,
    Number.isInteger(item.longest_gap_days)
      ? `longest gap ${formatInteger(item.longest_gap_days)} days`
      : null,
    Number.isInteger(item.latest_return_gap_days)
      ? `latest return after ${formatInteger(item.latest_return_gap_days)} days`
      : null,
    safeInlineText(item.historical_return_signal)
      ? `basis: ${safeInlineText(item.historical_return_signal)}`
      : null,
  ].filter(Boolean);
  return `${base}${details.length > 0 ? ` - ${details.join(", ")}` : ""}`;
}

function formatBackToBackTrack(item) {
  const base = formatTrackSignal(item);
  const details = [
    Number.isInteger(item.maximum_consecutive_plays)
      ? `${formatInteger(item.maximum_consecutive_plays)} plays in longest adjacent sequence`
      : null,
    Number.isInteger(item.burst_count)
      ? `${formatInteger(item.burst_count)} bounded ${item.burst_count === 1 ? "sequence" : "sequences"}`
      : null,
    Number.isInteger(item.plays_in_bursts)
      ? `${formatInteger(item.plays_in_bursts)} plays across sequences`
      : null,
    Number.isFinite(item.listening_minutes_in_bursts)
      ? `${formatListeningTime(item.listening_minutes_in_bursts)} across sequences`
      : null,
  ].filter(Boolean);
  return `${base}${details.length > 0 ? ` - ${details.join(", ")}` : ""}`;
}

function formatTimeCapsuleTrack(item) {
  const label = safeInlineText(item.label);
  const artist = safeInlineText(item.artist_credit);
  const details = [
    Number.isInteger(item.year_play_count)
      ? `${formatInteger(item.year_play_count)} plays in year`
      : null,
    Number.isFinite(item.year_listening_minutes)
      ? `${formatListeningTime(item.year_listening_minutes)} in year`
      : null,
    safeInlineText(item.representative_signal)
      ? `basis: ${safeInlineText(item.representative_signal)}`
      : null,
  ].filter(Boolean);
  return `- ${Number.isInteger(item.capsule_year) ? item.capsule_year : "Unknown year"}: ${label}${artist ? ` - ${artist}` : ""}${
    details.length > 0 ? ` - ${details.join(", ")}` : ""
  }`;
}

function formatHistoryArc(item) {
  const details = [];
  if (Number.isFinite(item.listening_minutes)) {
    details.push(formatListeningTime(item.listening_minutes));
  }
  if (Number.isInteger(item.event_count)) {
    details.push(`${formatInteger(item.event_count)} events`);
  }
  if (Number.isInteger(item.distinct_tracks)) {
    details.push(`${formatInteger(item.distinct_tracks)} tracks`);
  }
  if (Number.isInteger(item.first_observed_tracks)) {
    details.push(`${formatInteger(item.first_observed_tracks)} first observed`);
  }
  const topArtist = safeInlineText(item.top_artist?.name);
  if (topArtist) details.push(`most heard artist: ${topArtist}`);
  return `- ${Number.isInteger(item.year) ? item.year : "Unknown year"}${
    details.length > 0 ? ` - ${details.join(", ")}` : ""
  }`;
}

function formatListeningSeason(item) {
  const key = safeInlineText(item.key).replace("-", " ");
  const range = [safeInlineText(item.start_month), safeInlineText(item.end_month)]
    .filter(Boolean)
    .join(" to ");
  if (!Number.isInteger(item.event_count) || item.event_count === 0) {
    return `- ${key || "Unknown season"}${range ? ` (${range} UTC)` : ""} - no retained eligible events`;
  }
  const details = [
    Number.isFinite(item.listening_minutes)
      ? formatListeningTime(item.listening_minutes)
      : null,
    `${formatInteger(item.event_count)} events`,
    `${formatInteger(item.distinct_tracks)} tracks`,
    `${formatInteger(item.first_observed_tracks)} first observed`,
    `${formatInteger(item.returning_tracks)} seen earlier`,
    safeInlineText(item.leading_artist?.name)
      ? `leading artist: ${safeInlineText(item.leading_artist.name)}`
      : null,
    safeInlineText(item.signature_track?.label)
      ? `signature track: ${safeInlineText(item.signature_track.label)}${
          safeInlineText(item.signature_track?.artist_credit)
            ? ` - ${safeInlineText(item.signature_track.artist_credit)}`
            : ""
        }`
      : null,
  ].filter(Boolean);
  return `- ${key || "Unknown season"}${range ? ` (${range} UTC)` : ""} - ${details.join(", ")}`;
}

function formatListenerAssertion(item) {
  const label = safeInlineText(item.label);
  const artist = safeInlineText(item.artist_credit);
  const target = artist ? `${label} - ${artist}` : label;
  const note = safeInlineText(item.note);
  return `- ${item.stance === "avoid" ? "Avoid" : "Like"} ${safeInlineText(
    item.entity_type,
  )}: ${target} - correction ${safeInlineText(item.correction_id)}${
    note ? ` - ${note}` : ""
  }`;
}

function appendTasteSection(lines, title, values, formatter) {
  if (!Array.isArray(values) || values.length === 0) return;
  lines.push("", `## ${title}`, "", ...values.map(formatter));
}

function formatBehaviorContextLine(value, total, label, coverageLabel) {
  if (!Number.isInteger(value) || total === 0) return null;
  const validTotal = Number.isInteger(total) && total >= value && total > 0;
  const share = validTotal ? Math.round((value / total) * 1_000) / 10 : null;
  return `- ${label}: ${formatInteger(value)}${
    validTotal
      ? ` of ${formatInteger(total)} ${coverageLabel} (${share.toLocaleString("en-US")}%)`
      : ""
  }`;
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
  const lines = [
    "# Your Moondog tasteprint",
    "",
    "A private, local projection of what your music data can support today.",
    "",
    "## Coverage",
    "",
    `- Effective listening events: ${formatInteger(
      coverage.effective_listening_events,
    )}`,
    `- Listening time: ${
      !durationUnavailable && Number.isFinite(coverage.listening_hours)
        ? `${coverage.listening_hours.toLocaleString("en-US")} h`
        : "unknown"
    }`,
    `- Events with supplied played duration: ${formatInteger(
      coverage.events_with_played_duration,
    )}`,
    `- Distinct listened tracks: ${formatInteger(coverage.listening_tracks)}`,
    ...(Number.isInteger(coverage.cross_format_track_links)
      ? [
          `- Cross-format track links: ${formatInteger(
            coverage.cross_format_track_links,
          )} provisional identities across ${formatInteger(
            coverage.cross_format_linked_events,
          )} effective events`,
        ]
      : []),
    ...(Number.isInteger(coverage.cross_format_ambiguous_tracks) &&
    coverage.cross_format_ambiguous_tracks > 0
      ? [
          `- Ambiguous cross-format identities kept separate: ${formatInteger(
            coverage.cross_format_ambiguous_tracks,
          )} across ${formatInteger(
            coverage.cross_format_ambiguous_events,
          )} effective events`,
        ]
      : []),
    `- Saved library tracks: ${formatInteger(coverage.saved_tracks ?? coverage.spotify_saved_tracks)}`,
    `- Playlist memberships: ${formatInteger(
      coverage.playlist_memberships ?? coverage.spotify_playlist_memberships,
    )}`,
  ];
  for (const source of coverage.collection_sources ?? []) {
    if (source.tracks > 0) lines.push(`- ${safeInlineText(source.label)} collection: ${formatInteger(source.tracks)} tracks`);
  }
  if (range) lines.push(`- Listening range: ${range}`);
  if (Number.isInteger(context.incognito_events_excluded)) {
    lines.push(
      `- Incognito events excluded from taste inference: ${formatInteger(
        context.incognito_events_excluded,
      )}`,
    );
  }

  appendTasteSection(
    lines,
    "Your explicit corrections",
    profile.listener_assertions?.active,
    formatListenerAssertion,
  );

  appendTasteSection(
    lines,
    "Long arc",
    behavior.enduring_artists,
    listeningSignal(formatArtistSignal),
  );
  appendTasteSection(
    lines,
    `Recent movement${
      Number.isInteger(context.recent_window_days)
        ? ` (${context.recent_window_days} days)`
        : ""
    }`,
    behavior.recent_artists,
    listeningSignal(formatArtistSignal),
  );
  appendTasteSection(
    lines,
    "Listening through time (UTC)",
    behavior.history_arc,
    listeningSignal(formatHistoryArc),
  );
  const listeningSeasons = behavior.listening_seasons?.seasons;
  appendTasteSection(
    lines,
    "Listening Seasons (fixed UTC calendar quarters)",
    Array.isArray(listeningSeasons) ? listeningSeasons.slice(-12) : [],
    listeningSignal(formatListeningSeason),
  );
  if (Array.isArray(listeningSeasons) && listeningSeasons.length > 0) {
    lines.push(
      "Listening Seasons boundary: first observed means first appearance in retained history, not discovery. Leading artists and signature tracks describe only their fixed window and do not infer preference, mood, or life events.",
      "",
    );
  }
  appendTasteSection(
    lines,
    "Listening Time Machine",
    behavior.time_capsule_tracks,
    formatTimeCapsuleTrack,
  );
  appendTasteSection(
    lines,
    `Worth another listen${
      Number.isInteger(context.rediscovery_quiet_days)
        ? ` (quiet ${context.rediscovery_quiet_days}+ days)`
        : ""
    }`,
    behavior.rediscovery_tracks,
    formatRediscoveryTrack,
  );
  appendTasteSection(
    lines,
    `Music that came back${
      Number.isInteger(context.historical_return_minimum_gap_days)
        ? ` (gaps ${context.historical_return_minimum_gap_days}+ days)`
        : ""
    }`,
    behavior.historical_return_tracks,
    formatHistoricalReturnTrack,
  );
  appendTasteSection(
    lines,
    `Played back to back${
      Number.isInteger(context.back_to_back_minimum_consecutive_plays)
        ? ` (${context.back_to_back_minimum_consecutive_plays}+ adjacent plays)`
        : ""
    }`,
    behavior.back_to_back_tracks,
    formatBackToBackTrack,
  );
  if ((behavior.back_to_back_tracks ?? []).length > 0) {
    lines.push(
      "Back-to-back boundary: adjacent retained playback events do not prove repeat mode, intentional replay, or liking.",
      "",
    );
  }
  appendTasteSection(
    lines,
    "Tracks you return to",
    behavior.repeat_tracks,
    listeningSignal(formatTrackSignal),
  );
  appendTasteSection(
    lines,
    "Recent tracks",
    behavior.recent_tracks,
    listeningSignal(formatTrackSignal),
  );

  const behaviorContextLines = [
    formatBehaviorContextLine(
      context.direct_selection_starts,
      context.start_reason_events,
      "Direct starts",
      "start-reason events",
    ),
    formatBehaviorContextLine(
      context.trackdone_starts,
      context.start_reason_events,
      "Continued playback",
      "start-reason events",
    ),
    formatBehaviorContextLine(
      context.trackdone_endings,
      context.end_reason_events,
      "Reached track end",
      "end-reason events",
    ),
    formatBehaviorContextLine(
      context.explicit_skips,
      context.skip_state_events,
      "Explicit skips",
      "skip-state events",
    ),
    formatBehaviorContextLine(
      context.shuffle_events,
      context.shuffle_state_events,
      "Shuffle active",
      "shuffle-state events",
    ),
    formatBehaviorContextLine(
      context.offline_events,
      context.offline_state_events,
      "Offline playback",
      "offline-state events",
    ),
  ].filter(Boolean);
  if (behaviorContextLines.length > 0) {
    lines.push(
      "",
      "## Playback flow",
      "",
      ...behaviorContextLines,
      "",
      "Percentages use only events where Spotify supplied the corresponding field. These are playback-context signals, not proof of taste, attention, satisfaction, personality, location, or device use.",
    );
  }

  if (
    Array.isArray(profile.strong_preferences) &&
    profile.strong_preferences.length > 0
  ) {
    lines.push(
      "",
      "## Deliberate choices",
      "",
      ...profile.strong_preferences.map(
        (item) =>
          `- ${safeInlineText(item.label)} - ${safeInlineText(item.signal)}`,
      ),
    );
  }

  if (Array.isArray(profile.limitations) && profile.limitations.length > 0) {
    lines.push(
      "",
      "## Reading boundaries",
      "",
      ...profile.limitations.slice(0, 5).map(
        (limitation) => `- ${safeInlineText(limitation)}`,
      ),
    );
  }
  lines.push(
    "",
    profile.preview_source?.persistent_import === false
      ? "This one-off preview did not change Moondog's persistent listening history. Add `--json` to the same `--from` command for the complete bounded projection."
      : "Use `moondog taste --json` for the complete bounded projection, including evidence IDs and source coverage.",
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
