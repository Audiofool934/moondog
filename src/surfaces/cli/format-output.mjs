import { N_, screenTranslator } from "../../i18n/index.mjs";

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

function formatSource(source, tr) {
  if (!source.latest) return `- ${tr("Apple Music library: not imported")}`;
  return [
    `- ${tr("Apple Music library: {tracks} and {playlists}, as of {date}", {
      tracks: tr.n(source.latest.tracks, "{count} track", "{count} tracks"),
      playlists: tr.n(source.latest.playlists, "{count} playlist", "{count} playlists"),
      date: String(source.latest.captured_at).slice(0, 10) })}`,
    source.semantics?.complete_listening_history_available
      ? `- ${tr("Includes a full listening history")}`
      : `- ${tr("A library shows what you keep, not every play")}`,
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

function formatProfile(profile, tr) {
  if (profile.state !== "ready") {
    return `- ${profile.reason ? tr("Not ready yet: {reason}", { reason: profile.reason }) : tr("Not ready yet")}\n- ${tr("`/import` brings in your history")}`;
  }
  const lines = [];
  const listening = [
    Number.isInteger(profile.effective_listening_events) ? tr.n(profile.effective_listening_events, "{count} play", "{count} plays") : null,
    typeof profile.listening_hours === "number" && profile.listening_hours > 0 ? tr("{hours} h", { hours: tr.number(profile.listening_hours) }) : null,
    Array.isArray(profile.listening_sources) && profile.listening_sources.length > 0
      ? tr("from {services}", { services: profile.listening_sources.map((source) => serviceNames[source] ?? words(source)).join(", ") })
      : null,
  ].filter(Boolean);
  if (listening.length > 0) lines.push(`- ${listening.join(" · ")}`);
  if (Number.isInteger(profile.spotify_profile_evidence) && profile.spotify_profile_evidence > 0) {
    lines.push(`- ${tr.n(profile.spotify_profile_evidence, "{count} saved song, follow, or playlist entry from Spotify", "{count} saved songs, follows, and playlist entries from Spotify")}`);
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

function formatListeningTime(minutes, tr) {
  if (!Number.isFinite(minutes) || minutes < 0) return tr("unknown duration");
  if (minutes < 120) return tr("{minutes} min", { minutes: Math.round(minutes) });
  return tr("{hours} h", { hours: tr.number(Math.round((minutes / 60) * 10) / 10) });
}

function plays(value, tr) { return tr.n(value, "{count} play", "{count} plays"); }
function tracks(value, tr) { return tr.n(value, "{count} track", "{count} tracks"); }

function formatArtistSignal(item, tr) {
  const details = [];
  if (Number.isInteger(item.play_count)) details.push(plays(item.play_count, tr));
  if (Number.isFinite(item.listening_minutes)) details.push(formatListeningTime(item.listening_minutes, tr));
  if (Number.isInteger(item.distinct_tracks)) details.push(tracks(item.distinct_tracks, tr));
  return `- ${safeInlineText(item.name)}${details.length > 0 ? ` · ${details.join(", ")}` : ""}`;
}

function formatTrackSignal(item, tr) {
  const label = safeInlineText(item.label);
  const artist = safeInlineText(item.artist_credit);
  const details = [];
  if (Number.isInteger(item.play_count)) details.push(plays(item.play_count, tr));
  if (Number.isFinite(item.listening_minutes)) details.push(formatListeningTime(item.listening_minutes, tr));
  return `- ${label}${artist ? ` - ${artist}` : ""}${details.length > 0 ? ` · ${details.join(", ")}` : ""}`;
}

// Attention alone is the default reading, so only stronger evidence is worth naming.
const signalPhrases = {
  "historical attention only": () => null,
  "saved-library state": tr => tr("saved in your library"),
  "private playlist curation": tr => tr("on one of your playlists"),
  "explicit listener preference": tr => tr("you said you like it"),
};

function signalPhrase(value, tr) {
  const text = safeInlineText(value);
  if (!text) return null;
  return Object.hasOwn(signalPhrases, text) ? signalPhrases[text](tr) : text;
}

function withDetails(base, details) {
  const present = details.filter(Boolean);
  return `${base}${present.length > 0 ? ` · ${present.join(", ")}` : ""}`;
}

function formatRediscoveryTrack(item, tr) {
  return withDetails(formatTrackSignal(item, tr), [
    Number.isInteger(item.quiet_days) ? tr.n(item.quiet_days, "quiet for {count} day", "quiet for {count} days") : null,
    Number.isInteger(item.peak_year) ? tr("biggest in {year}", { year: item.peak_year }) : null,
    signalPhrase(item.rediscovery_signal, tr),
  ]);
}

function formatHistoricalReturnTrack(item, tr) {
  return withDetails(formatTrackSignal(item, tr), [
    Number.isInteger(item.return_count)
      ? item.return_count === 1 ? tr("came back once") : tr.n(item.return_count, "came back {count} time", "came back {count} times")
      : null,
    Number.isInteger(item.longest_gap_days) ? tr.n(item.longest_gap_days, "longest time away {count} day", "longest time away {count} days") : null,
    signalPhrase(item.historical_return_signal, tr),
  ]);
}

function formatBackToBackTrack(item, tr) {
  return withDetails(formatTrackSignal(item, tr), [
    Number.isInteger(item.maximum_consecutive_plays) ? tr("up to {count} in a row", { count: tr.number(item.maximum_consecutive_plays) }) : null,
    Number.isInteger(item.burst_count) && item.burst_count > 1 ? tr("{count} separate runs", { count: tr.number(item.burst_count) }) : null,
  ]);
}

function formatTimeCapsuleTrack(item, tr) {
  const label = safeInlineText(item.label);
  const artist = safeInlineText(item.artist_credit);
  return withDetails(
    `- ${Number.isInteger(item.capsule_year) ? item.capsule_year : tr("Unknown year")}  ${label}${artist ? ` - ${artist}` : ""}`,
    [
      Number.isInteger(item.year_play_count) ? tr.n(item.year_play_count, "{count} play that year", "{count} plays that year") : null,
      signalPhrase(item.representative_signal, tr),
    ],
  );
}

function formatHistoryArc(item, tr) {
  const details = [];
  if (Number.isFinite(item.listening_minutes)) details.push(formatListeningTime(item.listening_minutes, tr));
  if (Number.isInteger(item.event_count)) details.push(plays(item.event_count, tr));
  if (Number.isInteger(item.distinct_tracks)) details.push(tracks(item.distinct_tracks, tr));
  if (Number.isInteger(item.first_observed_tracks) && item.first_observed_tracks > 0) {
    details.push(tr("{count} new", { count: tr.number(item.first_observed_tracks) }));
  }
  const topArtist = safeInlineText(item.top_artist?.name);
  if (topArtist) details.push(tr("mostly {artist}", { artist: topArtist }));
  return `- ${Number.isInteger(item.year) ? item.year : tr("Unknown year")}${details.length > 0 ? ` · ${details.join(", ")}` : ""}`;
}

function formatListeningSeason(item, tr) {
  const key = safeInlineText(item.key).replace("-", " ");
  if (!Number.isInteger(item.event_count) || item.event_count === 0) {
    return `- ${key || tr("Unknown season")} · ${tr("nothing in your history")}`;
  }
  const signature = safeInlineText(item.signature_track?.label);
  const signatureArtist = safeInlineText(item.signature_track?.artist_credit);
  return withDetails(`- ${key || tr("Unknown season")}`, [
    Number.isFinite(item.listening_minutes) ? formatListeningTime(item.listening_minutes, tr) : null,
    plays(item.event_count, tr),
    Number.isInteger(item.first_observed_tracks) && item.first_observed_tracks > 0
      ? tr("{count} new", { count: tr.number(item.first_observed_tracks) }) : null,
    safeInlineText(item.leading_artist?.name) ? tr("mostly {artist}", { artist: safeInlineText(item.leading_artist.name) }) : null,
    signature ? tr("top song {song}", { song: `${signature}${signatureArtist ? ` - ${signatureArtist}` : ""}` }) : null,
  ]);
}

function formatListenerAssertion(item, tr) {
  const label = safeInlineText(item.label);
  const artist = safeInlineText(item.artist_credit);
  const target = artist ? `${label} - ${artist}` : label;
  const note = safeInlineText(item.note);
  const entity = item.entity_type === "track" ? tr("track") : item.entity_type === "artist" ? tr("artist") : safeInlineText(item.entity_type);
  return `- ${item.stance === "avoid" ? tr("Keep out") : tr("Like")}${entity ? ` (${entity})` : ""}: ${target}${
    note ? ` · "${note}"` : ""
  } · ${safeInlineText(item.correction_id)}`;
}

function appendTasteSection(lines, title, values, formatter, subtitle) {
  if (!Array.isArray(values) || values.length === 0) return;
  lines.push("", `## ${title}`, "", ...(subtitle ? [`*${subtitle}*`, ""] : []), ...values.map(formatter));
}

function formatBehaviorContextLine(value, total, label, tr) {
  if (!Number.isInteger(value) || total === 0) return null;
  const validTotal = Number.isInteger(total) && total >= value && total > 0;
  if (!validTotal) return `- ${label}: ${tr.number(value)}`;
  const share = Math.round((value / total) * 100);
  return `- ${label}: ${tr("{share}% ({count} of {total})", { share, count: tr.number(value), total: tr.number(total) })}`;
}

// Section names are Pink Floyd titles and stay as they are; their subtitles are translated.
function formatTaste(profile, tr) {
  const coverage = profile.coverage ?? {};
  const durationUnavailable = coverage.events_with_played_duration === 0;
  const listeningSignal = (formatter) => (item) => formatter(durationUnavailable ? { ...item, listening_minutes: undefined } : item, tr);
  const signal = (formatter) => (item) => formatter(item, tr);
  const behavior = profile.listening_behavior ?? {};
  const context = behavior.context ?? {};
  const listeningRange = profile.listening_source?.listening_range;
  const range =
    typeof listeningRange?.earliest === "string" &&
    typeof listeningRange?.latest === "string"
      ? tr("{first} to {last}", { first: listeningRange.earliest.slice(0, 10), last: listeningRange.latest.slice(0, 10) })
      : null;
  const oneOff = profile.preview_source?.persistent_import === false;
  const hours = !durationUnavailable && Number.isFinite(coverage.listening_hours)
    ? tr("{hours} h", { hours: tr.number(coverage.listening_hours) })
    : null;
  const lines = [
    `# ${tr("Your listening, so far")}`,
    "",
    oneOff
      ? tr("A one-off reading of the file you chose. Nothing was saved to your profile.")
      : tr("Read from your own files. It stays on this machine."),
    "",
    `## ${tr("What I'm reading from")}`,
    "",
  ];
  const summary = [
    Number.isInteger(coverage.effective_listening_events) ? plays(coverage.effective_listening_events, tr) : null,
    hours,
    Number.isInteger(coverage.listening_tracks) ? tracks(coverage.listening_tracks, tr) : null,
  ].filter(Boolean);
  if (summary.length > 0) lines.push(`- ${summary.join(" · ")}`);
  if (range) lines.push(`- ${range}`);
  const saved = coverage.saved_tracks ?? coverage.spotify_saved_tracks;
  if (Number.isInteger(saved) && saved > 0) lines.push(`- ${tr.n(saved, "{count} saved track", "{count} saved tracks")}`);
  const memberships = coverage.playlist_memberships ?? coverage.spotify_playlist_memberships;
  if (Number.isInteger(memberships) && memberships > 0) lines.push(`- ${tr.n(memberships, "{count} song on your playlists", "{count} songs on your playlists")}`);
  for (const source of coverage.collection_sources ?? []) {
    if (source.tracks > 0) lines.push(`- ${safeInlineText(source.label)}: ${tracks(source.tracks, tr)}`);
  }
  if (!durationUnavailable && Number.isInteger(coverage.events_with_played_duration) &&
    Number.isInteger(coverage.effective_listening_events) &&
    coverage.events_with_played_duration < coverage.effective_listening_events) {
    lines.push(`- ${tr("Listening time is known for {count} of those plays", { count: tr.number(coverage.events_with_played_duration) })}`);
  }
  if (Number.isInteger(coverage.cross_format_track_links) && coverage.cross_format_track_links > 0) {
    lines.push(`- ${tr.n(coverage.cross_format_track_links, "{count} track matched across your two Spotify exports", "{count} tracks matched across your two Spotify exports")}`);
  }
  if (Number.isInteger(coverage.cross_format_ambiguous_tracks) && coverage.cross_format_ambiguous_tracks > 0) {
    lines.push(`- ${tr.n(coverage.cross_format_ambiguous_tracks, "{count} track kept apart because the match was unclear", "{count} tracks kept apart because the match was unclear")}`);
  }
  if (Number.isInteger(context.incognito_events_excluded) && context.incognito_events_excluded > 0) {
    lines.push(`- ${tr.n(context.incognito_events_excluded, "{count} private-session play left out", "{count} private-session plays left out")}`);
  }

  appendTasteSection(lines, tr("What you told me"), profile.listener_assertions?.active, signal(formatListenerAssertion));
  appendTasteSection(lines, "Shine On", behavior.enduring_artists, listeningSignal(formatArtistSignal),
    tr("Artists who stayed with you across the years"));
  appendTasteSection(lines, tr("Lately"), behavior.recent_artists, listeningSignal(formatArtistSignal),
    Number.isInteger(context.recent_window_days)
      ? tr("Who you've played most in the last {count} days", { count: context.recent_window_days })
      : tr("Who you've played most recently"));
  appendTasteSection(lines, tr("Year by year"), behavior.history_arc, listeningSignal(formatHistoryArc));
  const listeningSeasons = behavior.listening_seasons?.seasons;
  appendTasteSection(lines, tr("Seasons"), Array.isArray(listeningSeasons) ? listeningSeasons.slice(-12) : [],
    listeningSignal(formatListeningSeason),
    tr("Your last twelve quarters. \"New\" means new to your history, not necessarily new to you."));
  appendTasteSection(lines, "Time", behavior.time_capsule_tracks, signal(formatTimeCapsuleTrack), tr("The years, one track each"));
  appendTasteSection(lines, "Wish You Were Here", behavior.rediscovery_tracks, signal(formatRediscoveryTrack),
    Number.isInteger(context.rediscovery_quiet_days)
      ? tr("Songs you used to play a lot that have gone quiet for {count}+ days", { count: context.rediscovery_quiet_days })
      : tr("Songs you used to play a lot that have gone quiet"));
  appendTasteSection(lines, "Coming Back to Life", behavior.historical_return_tracks, signal(formatHistoricalReturnTrack),
    Number.isInteger(context.historical_return_minimum_gap_days)
      ? tr("Songs that found their way back after {count}+ days away", { count: context.historical_return_minimum_gap_days })
      : tr("Songs that found their way back after long gaps"));
  appendTasteSection(lines, "Echoes", behavior.back_to_back_tracks, signal(formatBackToBackTrack), tr("Songs you played again right away"));
  appendTasteSection(lines, tr("Most played"), behavior.repeat_tracks, listeningSignal(formatTrackSignal));
  appendTasteSection(lines, tr("Recently"), behavior.recent_tracks, listeningSignal(formatTrackSignal));

  const behaviorContextLines = [
    formatBehaviorContextLine(context.direct_selection_starts, context.start_reason_events, tr("Songs you picked yourself"), tr),
    formatBehaviorContextLine(context.trackdone_starts, context.start_reason_events, tr("Songs that followed on"), tr),
    formatBehaviorContextLine(context.trackdone_endings, context.end_reason_events, tr("Played to the end"), tr),
    formatBehaviorContextLine(context.explicit_skips, context.skip_state_events, tr("Skipped"), tr),
    formatBehaviorContextLine(context.shuffle_events, context.shuffle_state_events, tr("On shuffle"), tr),
    formatBehaviorContextLine(context.offline_events, context.offline_state_events, tr("Offline"), tr),
  ].filter(Boolean);
  if (behaviorContextLines.length > 0) {
    lines.push("", `## ${tr("How you listen")}`, "", ...behaviorContextLines);
  }

  if (Array.isArray(profile.strong_preferences) && profile.strong_preferences.length > 0) {
    lines.push("", `## ${tr("Kept on purpose")}`, "",
      ...profile.strong_preferences.map((item) => `- ${safeInlineText(item.label)} · ${safeInlineText(item.signal).toLowerCase()}`));
  }

  lines.push(
    "",
    "## The dark side of the moon",
    "",
    `*${tr("What this reading can't see")}*`,
    "",
    `- ${tr("Plays show attention, not love. A song can be on repeat because it was stuck in your head.")}`,
    ...(behaviorContextLines.length > 0 ? [`- ${tr("A skip is a moment, not a verdict.")}`] : []),
    ...((behavior.history_arc ?? []).length > 0 || (listeningSeasons ?? []).length > 0
      ? [`- ${tr("Years and seasons follow UTC, so a late night can land on the next day.")}`,
        `- ${tr("A quiet stretch means no history was kept, not that you stopped listening.")}`]
      : []),
    `- ${tr("If something here is wrong, open the song or artist in /taste and tell me.")}`,
    "",
    oneOff
      ? tr("Add `--json` to the same `--from` command for the full data.")
      : tr("For the full data with evidence IDs, run `moondog taste --json`."),
  );
  return lines.join("\n");
}

function formatMemory(memory, tr) {
  const lines = [];
  if (Number.isInteger(memory.sessions)) {
    lines.push(
      `- ${tr.n(memory.sessions, "{count} conversation saved on this machine", "{count} conversations saved on this machine")}`,
      `- ${tr.n(memory.active_memories, "{count} thing I remember about you", "{count} things I remember about you")}`,
    );
    if (memory.reflection?.pending_episodes > 0) {
      lines.push(`- ${tr.n(memory.reflection.pending_episodes, "{count} recent moment I haven't thought over yet", "{count} recent moments I haven't thought over yet")}`);
    }
  } else {
    lines.push(`- ${words(memory.state)}`);
  }
  lines.push(
    "",
    tr("I keep what you tell me in conversation apart from your music profile."),
    tr("I only remember something for good when you say it plainly, or when you ask with `/remember`."),
    tr("`/forget <id>` removes it."),
  );
  if (Array.isArray(memory.memories) && memory.memories.length > 0) {
    lines.push("", `## ${tr("What I remember")}`, "",
      ...memory.memories.map((entry) => `- ${entry.text} · ${entry.kind} · \`${entry.memory_id}\``));
  }
  if (Array.isArray(memory.recent_episodes) && memory.recent_episodes.length > 0) {
    lines.push("", `## ${tr("Lately")}`, "",
      ...memory.recent_episodes.map((episode) => `- ${String(episode.occurred_at).slice(0, 10)} · ${episode.summary}`));
  }
  if (Array.isArray(memory.recent_sessions) && memory.recent_sessions.length > 0) {
    lines.push("", `## ${tr("Recent conversations")}`, "",
      ...memory.recent_sessions.map((session) => {
        const userTurns = session.turns.filter((turn) => turn.role === "user").map((turn) => turn.text).join(" / ");
        return `- ${String(session.started_at).slice(0, 10)} · ${userTurns}`;
      }));
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
  ready: tr => tr("ready"),
  enabled: tr => tr("ready"),
  available: tr => tr("ready"),
  blocked: tr => tr("not available yet"),
  unavailable: tr => tr("not available"),
  disabled: tr => tr("off"),
};

function formatTools(value, tr) {
  const rows = value.capabilities.map((capability) => {
    const label = capability.agent_tool?.label ? tr.marked(capability.agent_tool.label) : capability.id;
    const state = capabilityStates[capability.state]?.(tr) ?? words(capability.state);
    return `- **${label}** · ${state}\n  ${capability.description}${
      capability.blocked_by ? `\n  ${tr("Waiting on: {reason}", { reason: words(capability.blocked_by) })}` : ""
    }`;
  });
  return `# ${tr("What I can do")}\n\n${rows.join("\n")}`;
}

const doctorLabels = {
  "web.codex_cli": N_("Web lookups (Codex CLI)"),
  "node.version": "Node.js",
  "apple_music.source": N_("Apple Music library"),
  "profile.projection": N_("Listening profile"),
  "agent.runtime": N_("Model"),
  "music.discovery.open_similarity": N_("Finding similar music"),
  "external.effects": N_("Changes to your accounts"),
  "spotify.connection": "Spotify",
  "spotify.connected_action_scopes": N_("Spotify permissions"),
};

function formatDoctor(value, tr) {
  return [
    `# ${tr("Checkup")}`,
    "",
    ...value.checks.map((check) => {
      const state = check.ok ? tr("ok") : check.optional_for_local_commands ? tr("not set up (optional)") : tr("not working");
      const detail = words(check.actual ?? check.state ?? "unknown");
      const label = doctorLabels[check.id] ? tr.marked(doctorLabels[check.id]) : check.id;
      return `- ${label}: ${state} · ${detail}`;
    }),
  ].join("\n");
}

function formatRuntime(runtime, tr) {
  if (runtime?.state === "configured") {
    return `- ${runtime.provider && runtime.model ? tr("Talking through `{model}`", { model: `${runtime.provider}/${runtime.model}` }) : tr("Talking through your chosen model")}`;
  }
  return runtime?.reason === "provider_authentication_required"
    ? `- ${tr("Not signed in yet. `/auth` fixes that.")}`
    : `- ${tr("No model connected. `/model` picks one. Your profile works without it.")}`;
}

function formatSpotifyStatus(spotify, tr) {
  const state = spotify?.state ?? "not_configured";
  if (state === "ready" || state === "connected") return `- ${tr("Connected")}`;
  return state === "not_configured"
    ? `- ${tr("Not connected. `/import` > Spotify walks you through it.")}`
    : `- ${words(state)}`;
}

/** Local command output. The TUI passes its translator; the shell CLI uses English. */
export function formatLocalResult(command, value, tr = screenTranslator("en")) {
  switch (command) {
    case "status":
    case "sources":
      return [
        `# ${tr("Where things stand")}`,
        "",
        `## ${tr("Your profile")}`,
        "",
        formatProfile(value.profile, tr),
        formatSource(value.source, tr),
        "",
        `## ${tr("Talking")}`,
        "",
        formatRuntime(value.runtime, tr),
        "",
        `## ${tr("Memory")}`,
        "",
        formatMemory(value.memory, tr),
        "",
        "## Spotify",
        "",
        formatSpotifyStatus(value.spotify, tr),
        "",
        value.external_effects === "disabled" && (value.spotify?.external_effects ?? "disabled") === "disabled"
          ? tr("Right now I can't change anything in your music accounts.")
          : tr("I can make changes in your connected accounts, and I always ask first."),
      ].join("\n");
    case "profile":
      return `# ${tr("Your profile")}\n\n${formatProfile(value, tr)}`;
    case "taste":
      return formatTaste(value, tr);
    case "memory":
      return `# ${tr("What I remember")}\n\n${formatMemory(value, tr)}`;
    case "tools":
      return formatTools(value, tr);
    case "doctor":
      return formatDoctor(value, tr);
    default:
      return JSON.stringify(value, null, 2);
  }
}

export function helpText(tr = screenTranslator("en")) {
  return tr("# Every command\n\nFrom your shell:\n\n- `moondog --version` - show the installed version\n- `moondog update [--check] [--channel latest|beta]` - check for or install a published release\n- `moondog web status|search|read [arguments] [--json]` - look things up on public music sites through the Codex CLI\n- `moondog studio` - open the browser Studio for dropping in a Spotify ZIP\n- `moondog studio --demo` - try the Studio with made-up history; your own data is never read\n- `moondog studio --from <spotify-history.zip>` - look at one Spotify ZIP in the Studio without saving it\n- `moondog studio --from <account-data.zip> --from <extended-history.zip>` - combine two Spotify ZIPs in the Studio without saving them\n- `moondog demo-history --output <absolute-file.zip> [--json]` - make a fictional Spotify history ZIP to try the importer with\n- `moondog auth login <provider>` - sign in to a model provider; the key is typed out of sight, and openai-codex uses your ChatGPT sign-in\n- `moondog auth status [provider]` - see which sign-ins are saved\n- `moondog auth logout <provider>` - sign out of a provider\n- `moondog spotify help` - set up and control Spotify\n- `moondog spotify login [client-id]` - connect Spotify in your browser\n- `moondog spotify now|devices|queue` - see what Spotify is playing, where, and what's next\n- `moondog spotify recent` - see what you played lately\n- `moondog spotify sync-recent` - add your latest plays to your profile\n- `moondog spotify sync-library` - add your Spotify library to your profile\n- `moondog spotify play|pause|next|previous` - control Spotify playback\n- `moondog listenbrainz import-history <listen-history.json>` - add a ListenBrainz listens file to your profile\n- `moondog catalog latest-single --artist <name> [--known-release <title> | --from <spotify-history.zip>]` - find an artist's latest single on Apple Music (US), no model needed\n- `moondog status [--json]` - see where things stand\n- `moondog taste [--json]` - your listening report\n- `moondog taste --html [--output <file.html>]` - save your report as a web page that works offline\n- `moondog taste --card [--output <file.html>]` - save a short recap you can check before sharing\n- `moondog taste --from <spotify-history.zip> --html` - a one-off report from a Spotify ZIP, without saving it\n- `moondog taste --from <account-data.zip> --from <extended-history.zip> --html` - a one-off report from both Spotify exports together\n- `moondog taste --from <spotify-history.zip> --save --html` - save the Spotify history, then show your full report\n- `moondog data inspect --scope <listening|apple|profile>` - see what's stored, and get the code needed to reset it\n- `moondog data export --scope <listening|apple|profile> --output <directory>` - export a copy, leaving the original alone\n- `moondog data reset --scope <listening|apple|profile> --confirm <token>` - set stored data aside (it is archived, not deleted)\n- `moondog profile build [--force]` - build or resume a saved profile with your connected model\n- `moondog profile saved [offset]` - read your saved profile\n- `moondog profile explain <number>` - trace a saved finding to its evidence\n- `moondog profile corrections [--all]` - everything you've told me, including earlier choices\n- `moondog profile correct --artist <name> (--like|--avoid)` - like an artist, or keep them out\n- `moondog profile correct --track <title> --by <artist> (--like|--avoid)` - like a track, or keep it out\n- `moondog profile retract <correction-id>` - undo one of your choices\n- `moondog demo --offline [--json]` - a demo with made-up data, no sign-in needed\n- `moondog demo [prompt] [--json]` - the same demo, talking through your model\n- `moondog ask <prompt>` - ask one question and exit\n- `moondog remember <text>` - ask me to remember something\n- `moondog forget <memory-id>` - forget something\n- `moondog memory reflect [--dry-run] [--json]` - let me think over recent conversations now\n- `moondog` - open the listening room\n\nInside the listening room:\n\n- `/update [--check] [--channel latest|beta]` - check for updates, or save and close this session to install one\n- `/status` or `/sources` - see where things stand\n- `/profile` or `/taste` - your profile, and why each song or artist is there\n- `/taste report` - the whole report on one page\n- `/profile build [--force]` - build or resume a saved reading; Ctrl+C keeps progress\n- `/profile saved [offset]` - read your saved profile\n- `/profile explain <number>` - inspect a saved finding's evidence\n- `/profile corrections [--all]` - everything you've told me\n- `/profile correct --track \"<title>\" --by \"<artist>\" (--like|--avoid)` - like a track, or keep it out\n- `/profile correct --artist \"<name>\" (--like|--avoid)` - like an artist, or keep them out\n- `/profile retract <correction-id>` - undo a choice\n- `/memory` - what I remember\n- `/tools` - what I can do right now\n- `/doctor` - check your setup\n- `/model` - pick the model I talk through\n- `/model <provider> <model>` - switch straight to a model\n- `/model refresh [provider]` - update public model choices; keep the selected model\n- `/auth [provider]` - sign in to a model provider\n- `/web status|search|read` - look things up on public music sites\n- `/import [path]` - bring in your history, library, or a playlist\n- `/language` - choose the language Moondog uses\n- `/spotify` - Spotify commands\n- `/spotify login [client-id]` - connect Spotify\n- `/spotify now|devices|queue` - see what's playing, where, and what's next\n- `/spotify recent|sync-recent` - see or save your latest plays\n- `/spotify import-history \"/path/to/spotify-history.zip\"` - add a Spotify ZIP, no sign-in needed\n- `/reload` - reload model settings and sign-ins\n- `/remember [kind] <text>` - ask me to remember something\n- `/forget <memory-id>` - forget something\n- `/rewind` or Alt+R - edit an earlier message on a new branch; the original stays saved\n- `/rewind latest` - edit the most recent message\n- `/resume` - pick up a saved conversation\n- `/resume <session-id>` - go straight to one\n- `/new` - start fresh; the last one stays saved\n- `/quit` - exit\n\nAnything you type that isn't a command goes to the model you picked with `/model`, or the one set in `MOONDOG_PROVIDER` and `MOONDOG_MODEL`.\nSign in with `/auth`, or set the provider's API key in your environment. `/auth openai-codex` uses your ChatGPT sign-in.\nOnce your profile is ready, I can search your library, explain what I see, and plan playlists with you.\nI can only control Spotify after `moondog spotify login`, and I never post, send messages, delete anything, or spend money.\nAsk me to move playback onto a device by name, such as your iPhone.");
}
