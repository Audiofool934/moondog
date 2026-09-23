import { sanitizeTerminalText } from "./format-output.mjs";

const MAX_ITEMS_PER_SOURCE = 10;

function items(value) {
  return Array.isArray(value) ? value.slice(0, MAX_ITEMS_PER_SOURCE) : [];
}

function inline(value) {
  return typeof value === "string"
    ? sanitizeTerminalText(value).replace(/\s+/gu, " ").trim()
    : "";
}

function identity(value) {
  return inline(value).normalize("NFKC").toLocaleLowerCase("und");
}

function identifier(value) {
  return typeof value === "string" && value.trim() && value.length <= 128 &&
    value === inline(value) ? value : undefined;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString("en-US")
    : undefined;
}

function amount(value) {
  return Number.isFinite(value) && value >= 0
    ? value.toLocaleString("en-US", { maximumFractionDigits: 1 })
    : undefined;
}

function date(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/u.test(value) &&
    Number.isFinite(Date.parse(value)) ? inline(value).slice(0, 10) : "";
}

function targetFor(item, kind) {
  const label = kind === "artist" ? item?.name ?? item?.label : item?.label;
  if (!inline(label) || !["artist", "track"].includes(kind)) return null;
  if (kind === "track" && !inline(item?.artist_credit)) return null;
  return {
    entityType: kind,
    label,
    ...(kind === "track" ? { artistCredit: item.artist_credit } : {}),
  };
}

function subjectKey(target) {
  return JSON.stringify([
    target.entityType,
    identity(target.label),
    ...(target.entityType === "track" ? [identity(target.artistCredit)] : []),
  ]);
}

function plural(value, one, many = `${one}s`) {
  return `${count(value)} ${value === 1 ? one : many}`;
}

function itemMetrics(item) {
  const values = [];
  const known = (field) => count(item?.[field]) !== undefined;
  if (known("play_count")) values.push(plural(item.play_count, "play"));
  if (known("engaged_play_count") && item.engaged_play_count !== item.play_count) {
    values.push(`${count(item.engaged_play_count)} heard properly`);
  }
  if (known("distinct_tracks")) values.push(plural(item.distinct_tracks, "track"));
  if (known("explicit_skips") && item.explicit_skips > 0) values.push(`skipped ${plural(item.explicit_skips, "time")}`);
  if (known("playlist_count")) values.push(`on ${plural(item.playlist_count, "playlist")}`);
  if (known("quiet_days")) values.push(`quiet for ${plural(item.quiet_days, "day")}`);
  if (known("return_count")) values.push(`came back ${item.return_count === 1 ? "once" : `${count(item.return_count)} times`}`);
  if (known("longest_gap_days")) values.push(`longest time away ${plural(item.longest_gap_days, "day")}`);
  if (known("maximum_consecutive_plays")) values.push(`up to ${count(item.maximum_consecutive_plays)} in a row`);
  if (known("burst_count") && item.burst_count > 1) values.push(`${count(item.burst_count)} separate runs`);
  const minutes = amount(item?.listening_minutes);
  if (minutes !== undefined) values.push(`${minutes} min`);
  const lastPlayed = date(item?.last_played_at);
  if (lastPlayed) values.push(`last played ${lastPlayed}`);
  if (Number.isFinite(item?.confidence) && item.confidence >= 0 && item.confidence <= 1) {
    values.push(`${Math.round(item.confidence * 100)}% sure`);
  }
  return values;
}

function overview(profile) {
  const coverage = profile?.coverage ?? {};
  const lines = [];
  const durationUnavailable = coverage.effective_listening_events > 0 && coverage.events_with_played_duration === 0;
  const listening = [
    [count(coverage.effective_listening_events), coverage.effective_listening_events === 1 ? "play" : "plays"],
    [durationUnavailable ? undefined : amount(coverage.listening_hours), "h"],
    [count(coverage.listening_tracks), coverage.listening_tracks === 1 ? "track" : "tracks"],
  ].filter(([value]) => value !== undefined).map(([value, label]) => `${value} ${label}`);
  if (durationUnavailable) listening.push("listening time unknown");
  if (listening.length && !(coverage.effective_listening_events === 0 && (coverage.tracks_observed > 0 || coverage.collection_tracks > 0))) {
    lines.push(listening.join(" · "));
  }
  if (Number.isSafeInteger(coverage.tracks_observed) && coverage.tracks_observed > 0) {
    const loved = count(coverage.loved_or_favorited);
    lines.push(`Apple Music library: ${plural(coverage.tracks_observed, "track")}${
      loved === undefined ? "" : ` · ${loved} loved`
    }`);
  }
  const source = profile?.listening_source ?? {};
  const collections = items(coverage.collection_sources).filter((collection) => collection.tracks > 0);
  if (collections.length > 1) lines.push(`${count(coverage.collection_tracks)} songs across ${collections.length} services`);
  for (const collection of collections) {
    if (collection.tracks > 0) lines.push(`${inline(collection.label)}: ${plural(collection.tracks, "song")}`);
  }
  const providers = items(source.providers).map(inline).filter(Boolean).map((provider) => ({
    spotify: "Spotify",
    listenbrainz: "ListenBrainz",
    lastfm: "Last.fm",
    apple_music: "Apple Music",
    youtube_music: "YouTube Music",
  })[provider] ?? provider);
  const earliest = date(source.listening_range?.earliest);
  const latest = date(source.listening_range?.latest);
  const range = earliest && latest ? `${earliest} to ${latest}` : earliest || latest;
  if (providers.length || range) {
    lines.push([providers.length ? `${providers.join(", ")} history` : "History", range]
      .filter(Boolean).join(" · "));
  }
  const captured = date(profile?.source?.captured_at);
  if (captured) lines.push(`Library as of ${captured}`);
  const active = count(coverage.active_listener_assertions);
  if (coverage.active_listener_assertions > 0) lines.push(`${plural(coverage.active_listener_assertions, "choice")} you've made`);
  return lines;
}

const sourceNames = {
  "Apple Music library preference": "In your Apple Music library",
  "Apple Music aggregate play count": "Apple Music play count",
};

function explicitKind(item) {
  if (["artist", "track"].includes(item?.entity_type)) return item.entity_type;
  if (item?.track_ref_id || item?.track_ref?.track_ref_id) return "track";
  if (inline(item?.name) && !item?.artist_credit) return "artist";
  return null;
}

/** Build a private, bounded review view from structured profile evidence. */
export function buildTasteProfileModel(profile = {}) {
  const metrics = (item) => itemMetrics(profile.coverage?.events_with_played_duration === 0
    ? { ...item, listening_minutes: undefined } : item);
  const subjects = new Map();
  const seenDetails = new Map();
  const assertions = profile?.listener_assertions ?? {};
  const behavior = profile?.listening_behavior ?? {};
  const curated = profile?.curated_preferences ?? {};

  function add(item, kind, source, detail, { assertion = false } = {}) {
    const target = targetFor(item, kind);
    if (!target) return;
    const key = subjectKey(target);
    let subject = subjects.get(key);
    if (!subject) {
      subject = {
        key,
        label: inline(target.label),
        subtitle: kind === "track" ? inline(target.artistCredit) : "Artist",
        kind,
        detailLines: [],
        target,
        evidence: [],
      };
      subjects.set(key, subject);
      seenDetails.set(key, new Set());
    }
    const evidenceId = identifier(item?.evidence_id);
    if (evidenceId && !subject.evidence.some((evidence) => evidence.id === evidenceId)) {
      subject.evidence.push({ id: evidenceId, source: inline(source) });
      subject.evidenceId ??= evidenceId;
    }
    if (assertion && ["like", "avoid"].includes(item?.stance) && !subject.stance) {
      subject.stance = item.stance;
      const correctionId = identifier(item.correction_id);
      if (correctionId) subject.correctionId = correctionId;
    }
    const line = inline(detail);
    if (line && !seenDetails.get(key).has(line)) {
      subject.detailLines.push(line);
      seenDetails.get(key).add(line);
    }
  }

  const activeAssertions = [
    ...items(assertions.active),
    ...items(assertions.preferences),
    ...items(assertions.avoids),
  ];
  const seenAssertions = new Set();
  for (const item of activeAssertions) {
    if (!["like", "avoid"].includes(item?.stance)) continue;
    const target = targetFor(item, item.entity_type);
    if (!target) continue;
    const key = subjectKey(target);
    if (seenAssertions.has(key)) continue;
    seenAssertions.add(key);
    const when = date(item.asserted_at);
    const note = inline(item.note);
    add(item, item.entity_type, "Your choice", `You said: ${
      item.stance === "like" ? "I like this" : "keep this out"
    }${when ? ` · ${when}` : ""}${note ? ` · "${note}"` : ""}`, { assertion: true });
  }

  const recentDays = count(behavior.context?.recent_window_days);
  const recentSource = recentDays ? `Lately (last ${recentDays} days)` : "Lately";
  for (const [field, kind, source] of [
    ["repeat_tracks", "track", "Most played"],
    ["enduring_artists", "artist", "Across the years"],
    ["recent_tracks", "track", recentSource],
    ["recent_artists", "artist", recentSource],
    ["rediscovery_tracks", "track", "Gone quiet"],
    ["historical_return_tracks", "track", "Came back"],
    ["back_to_back_tracks", "track", "Played in a row"],
  ]) {
    for (const item of items(behavior[field])) {
      const details = metrics(item);
      add(item, kind, source, `${source}${details.length ? `: ${details.join(" · ")}` : ""}`);
    }
  }
  for (const item of items(behavior.time_capsule_tracks)) {
    const year = count(item?.capsule_year);
    const details = metrics({
      play_count: item?.year_play_count,
      engaged_play_count: item?.year_engaged_play_count,
      listening_minutes: item?.year_listening_minutes,
      explicit_skips: item?.year_explicit_skips,
    });
    add(item, "track", "Song of the year", `${year ? `Your song of ${item.capsule_year}` : "Song of the year"}${
      details.length ? `: ${details.join(" · ")}` : ""
    }`);
  }
  for (const [field, kind, source] of [
    ["saved_tracks", "track", "Saved in your Spotify library"],
    ["playlist_anchors", "track", "On your Spotify playlists"],
    ["followed_artists", "artist", "Followed on Spotify"],
  ]) {
    for (const item of items(curated[field])) {
      const details = metrics(item);
      const label = source.replace("Spotify", inline(item.source_label) || "Spotify");
      add(item, kind, label, `${label}${details.length ? `: ${details.join(" · ")}` : ""}`);
    }
  }
  for (const item of items(curated.avoids)) {
    const target = targetFor(item, item?.entity_type);
    if (target && !seenAssertions.has(subjectKey(target))) {
      add(item, item.entity_type, "Disliked in your music service", "You disliked this in your music service. You can still change it here.");
    }
  }
  for (const [field, kind] of [["artists", "artist"], ["tracks", "track"]]) {
    for (const item of items(profile?.provider_signals?.[field])) {
      const rank = count(item?.best_rank);
      const details = [...(rank ? [`best at #${rank}`] : []), ...metrics(item)];
      add(item, kind, "Service top list", `In your service's top list${details.length ? `: ${details.join(" · ")}` : ""}`);
    }
  }
  for (const [field, fallback] of [["strong_preferences", "From your library"], ["familiarity", "Familiar from your library"]]) {
    for (const item of items(profile?.[field])) {
      const kind = explicitKind(item);
      if (!kind) continue;
      const target = targetFor(item, kind);
      if (!target) continue;
      const existing = subjects.get(subjectKey(target));
      if (item.evidence_id && existing?.evidence.some((evidence) => evidence.id === item.evidence_id)) continue;
      const source = sourceNames[inline(item.source)] ?? (inline(item.source) || fallback);
      const observed = date(item.observed_at);
      const details = [inline(item.signal).replace(/,? non-computed rating/u, ", rated"), ...metrics(item), ...(observed ? [`as of ${observed}`] : [])].filter(Boolean);
      add(item, kind, source, `${source}${details.length ? `: ${details.join(" · ")}` : ""}`);
    }
  }
  for (const item of items(profile?.artist_facets)) {
    const target = targetFor(item, "artist");
    if (!target) continue;
    const existing = subjects.get(subjectKey(target));
    if (item.evidence_id && existing?.evidence.some((evidence) => evidence.id === item.evidence_id)) continue;
    add(item, "artist", "Through a track", "Shows up through one of their tracks.");
  }

  for (const subject of subjects.values()) {
    if (subject.kind !== "track") continue;
    const artist = subjects.get(subjectKey({ entityType: "artist", label: subject.target.artistCredit }));
    if (artist?.stance !== "avoid") continue;
    subject.detailLines.unshift(`You asked me to keep ${artist.label} out.${
      subject.stance === "like" ? " That still applies, even though you like this track." : ""
    }`);
    if (artist.evidenceId && !subject.evidence.some((evidence) => evidence.id === artist.evidenceId)) {
      subject.evidence.push({ id: artist.evidenceId, source: "Your choice for the artist" });
    }
  }

  return {
    summaryLines: overview(profile),
    subjects: [...subjects.values()],
    emptyLines: [
      "Nothing to look at yet.",
      "Import your history or library and it will show up here.",
    ],
  };
}
