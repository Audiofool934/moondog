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

function metrics(item) {
  const values = [];
  for (const [field, label] of [
    ["play_count", "plays"],
    ["engaged_play_count", "engaged plays"],
    ["distinct_tracks", "tracks"],
    ["explicit_skips", "explicit skips"],
    ["playlist_count", "playlists"],
    ["quiet_days", "days since last play in this archive"],
    ["return_count", "historical returns"],
    ["longest_gap_days", "days in longest return gap"],
    ["maximum_consecutive_plays", "maximum consecutive plays"],
    ["burst_count", "repeat bursts"],
  ]) {
    const value = count(item?.[field]);
    if (value !== undefined) values.push(`${value} ${label}`);
  }
  const minutes = amount(item?.listening_minutes);
  if (minutes !== undefined) values.push(`${minutes} min with supplied duration`);
  const lastPlayed = date(item?.last_played_at);
  if (lastPlayed) values.push(`last played ${lastPlayed}`);
  if (Number.isFinite(item?.confidence) && item.confidence >= 0 && item.confidence <= 1) {
    values.push(`confidence ${Math.round(item.confidence * 100)}%`);
  }
  return values;
}

function overview(profile) {
  const coverage = profile?.coverage ?? {};
  const lines = [];
  const durationUnavailable = coverage.effective_listening_events > 0 && coverage.events_with_played_duration === 0;
  const listening = [
    [count(coverage.effective_listening_events), "listening events"],
    [durationUnavailable ? undefined : amount(coverage.listening_hours), "h"],
    [count(coverage.listening_tracks), "tracks"],
  ].filter(([value]) => value !== undefined).map(([value, label]) => `${value} ${label}`);
  if (durationUnavailable) listening.push("Listening time is unavailable");
  if (listening.length) lines.push(listening.join(" · "));
  if (Number.isSafeInteger(coverage.tracks_observed) && coverage.tracks_observed > 0) {
    const loved = count(coverage.loved_or_favorited);
    lines.push(`Apple Music library: ${count(coverage.tracks_observed)} tracks${
      loved === undefined ? "" : ` · ${loved} loved or favorited`
    }`);
  }
  const source = profile?.listening_source ?? {};
  const providers = items(source.providers).map(inline).filter(Boolean).map((provider) => ({
    spotify: "Spotify",
    listenbrainz: "ListenBrainz",
    lastfm: "Last.fm",
    apple_music: "Apple Music",
  })[provider] ?? provider);
  const earliest = date(source.listening_range?.earliest);
  const latest = date(source.listening_range?.latest);
  const range = earliest && latest ? `${earliest} to ${latest}` : earliest || latest;
  if (providers.length || range) {
    lines.push([providers.length ? `History: ${providers.join(", ")}` : "History", range]
      .filter(Boolean).join(" · "));
  }
  const captured = date(profile?.source?.captured_at);
  if (captured) lines.push(`Library snapshot: ${captured}`);
  const active = count(coverage.active_listener_assertions);
  if (active !== undefined) lines.push(`Your corrections: ${active} active`);
  return lines;
}

function explicitKind(item) {
  if (["artist", "track"].includes(item?.entity_type)) return item.entity_type;
  if (item?.track_ref_id || item?.track_ref?.track_ref_id) return "track";
  if (inline(item?.name) && !item?.artist_credit) return "artist";
  return null;
}

/** Build a private, bounded review view from structured profile evidence. */
export function buildTasteProfileModel(profile = {}) {
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
    add(item, item.entity_type, "Your correction", `Your correction: ${
      item.stance === "like" ? "Like" : "Avoid"
    }${when ? ` · ${when}` : ""}${note ? ` · ${note}` : ""}`, { assertion: true });
  }

  const recentDays = count(behavior.context?.recent_window_days);
  const recentSource = recentDays ? `Recent listening (${recentDays}-day archive window)` : "Recent listening";
  for (const [field, kind, source] of [
    ["repeat_tracks", "track", "Repeated listening"],
    ["enduring_artists", "artist", "Artist listening history"],
    ["recent_tracks", "track", recentSource],
    ["recent_artists", "artist", recentSource],
    ["rediscovery_tracks", "track", "Rediscovery evidence"],
    ["historical_return_tracks", "track", "Historical return evidence"],
    ["back_to_back_tracks", "track", "Consecutive listening"],
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
    add(item, "track", "Time capsule", `Time capsule${year ? ` (${item.capsule_year})` : ""}${
      details.length ? `: ${details.join(" · ")}` : ""
    }`);
  }
  for (const [field, kind, source] of [
    ["saved_tracks", "track", "Saved in Spotify library"],
    ["playlist_anchors", "track", "Spotify playlist membership"],
    ["followed_artists", "artist", "Followed on Spotify"],
  ]) {
    for (const item of items(curated[field])) {
      const details = metrics(item);
      add(item, kind, source, `${source}${details.length ? `: ${details.join(" · ")}` : ""}`);
    }
  }
  for (const item of items(curated.avoids)) {
    const target = targetFor(item, item?.entity_type);
    if (target && !seenAssertions.has(subjectKey(target))) {
      add(item, item.entity_type, "Imported provider Avoid", "Imported provider Avoid; this is not a Moondog correction.");
    }
  }
  for (const [field, kind] of [["artists", "artist"], ["tracks", "track"]]) {
    for (const item of items(profile?.provider_signals?.[field])) {
      const rank = count(item?.best_rank);
      const details = [...(rank ? [`best rank ${rank}`] : []), ...metrics(item)];
      add(item, kind, "Provider ranking", `Provider ranking${details.length ? `: ${details.join(" · ")}` : ""}`);
    }
  }
  for (const [field, fallback] of [["strong_preferences", "Imported preference signal"], ["familiarity", "Imported familiarity"]]) {
    for (const item of items(profile?.[field])) {
      const kind = explicitKind(item);
      if (!kind) continue;
      const target = targetFor(item, kind);
      if (!target) continue;
      const existing = subjects.get(subjectKey(target));
      if (item.evidence_id && existing?.evidence.some((evidence) => evidence.id === item.evidence_id)) continue;
      const source = inline(item.source) || fallback;
      const observed = date(item.observed_at);
      const details = [inline(item.signal), ...metrics(item), ...(observed ? [`observed ${observed}`] : [])].filter(Boolean);
      add(item, kind, source, `${source}${details.length ? `: ${details.join(" · ")}` : ""}`);
    }
  }
  for (const item of items(profile?.artist_facets)) {
    const target = targetFor(item, "artist");
    if (!target) continue;
    const existing = subjects.get(subjectKey(target));
    if (item.evidence_id && existing?.evidence.some((evidence) => evidence.id === item.evidence_id)) continue;
    add(item, "artist", "Artist facet", "Artist appears in the profile; its supporting evidence may concern a track.");
  }

  for (const subject of subjects.values()) {
    if (subject.kind !== "track") continue;
    const artist = subjects.get(subjectKey({ entityType: "artist", label: subject.target.artistCredit }));
    if (artist?.stance !== "avoid") continue;
    subject.detailLines.unshift(`Artist correction: Avoid applies to ${artist.label}.${
      subject.stance === "like" ? " Your track Like does not override the artist Avoid." : ""
    }`);
    if (artist.evidenceId && !subject.evidence.some((evidence) => evidence.id === artist.evidenceId)) {
      subject.evidence.push({ id: artist.evidenceId, source: "Your artist Avoid" });
    }
  }

  return {
    summaryLines: overview(profile),
    subjects: [...subjects.values()],
    emptyLines: [
      "No tracks or artists are available to review yet.",
      "Import listening history or a music library to build your profile.",
    ],
  };
}
