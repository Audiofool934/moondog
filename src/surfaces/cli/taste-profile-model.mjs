import { sanitizeTerminalText } from "./format-output.mjs";
import { intlLocale, screenTranslator } from "../../i18n/index.mjs";

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

function amount(value, locale = "en") {
  return Number.isFinite(value) && value >= 0
    ? value.toLocaleString(intlLocale(locale), { maximumFractionDigits: 1 })
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

function itemMetrics(item, tr) {
  const values = [];
  const known = (field) => count(item?.[field]) !== undefined;
  if (known("play_count")) values.push(tr.n(item.play_count, "{count} play", "{count} plays"));
  if (known("engaged_play_count") && item.engaged_play_count !== item.play_count) {
    values.push(tr("{count} heard properly", { count: tr.number(item.engaged_play_count) }));
  }
  if (known("distinct_tracks")) values.push(tr.n(item.distinct_tracks, "{count} track", "{count} tracks"));
  if (known("explicit_skips") && item.explicit_skips > 0) values.push(tr.n(item.explicit_skips, "skipped {count} time", "skipped {count} times"));
  if (known("playlist_count")) values.push(tr.n(item.playlist_count, "on {count} playlist", "on {count} playlists"));
  if (known("quiet_days")) values.push(tr.n(item.quiet_days, "quiet for {count} day", "quiet for {count} days"));
  if (known("return_count")) values.push(item.return_count === 1 ? tr("came back once") : tr.n(item.return_count, "came back {count} time", "came back {count} times"));
  if (known("longest_gap_days")) values.push(tr.n(item.longest_gap_days, "longest time away {count} day", "longest time away {count} days"));
  if (known("maximum_consecutive_plays")) values.push(tr("up to {count} in a row", { count: tr.number(item.maximum_consecutive_plays) }));
  if (known("burst_count") && item.burst_count > 1) values.push(tr("{count} separate runs", { count: tr.number(item.burst_count) }));
  const minutes = amount(item?.listening_minutes, tr.locale);
  if (minutes !== undefined) values.push(tr("{minutes} min", { minutes }));
  const lastPlayed = date(item?.last_played_at);
  if (lastPlayed) values.push(tr("last played {date}", { date: lastPlayed }));
  if (Number.isFinite(item?.confidence) && item.confidence >= 0 && item.confidence <= 1) {
    values.push(tr("{percent}% sure", { percent: Math.round(item.confidence * 100) }));
  }
  return values;
}

function overview(profile, tr) {
  const coverage = profile?.coverage ?? {};
  const lines = [];
  const durationUnavailable = coverage.effective_listening_events > 0 && coverage.events_with_played_duration === 0;
  const hours = durationUnavailable ? undefined : amount(coverage.listening_hours, tr.locale);
  const listening = [
    ...(count(coverage.effective_listening_events) !== undefined ? [tr.n(coverage.effective_listening_events, "{count} play", "{count} plays")] : []),
    ...(hours !== undefined ? [tr("{hours} h", { hours })] : []),
    ...(count(coverage.listening_tracks) !== undefined ? [tr.n(coverage.listening_tracks, "{count} track", "{count} tracks")] : []),
  ];
  if (durationUnavailable) listening.push(tr("listening time unknown"));
  if (listening.length && !(coverage.effective_listening_events === 0 && (coverage.tracks_observed > 0 || coverage.collection_tracks > 0))) {
    lines.push(listening.join(" · "));
  }
  if (Number.isSafeInteger(coverage.tracks_observed) && coverage.tracks_observed > 0) {
    const loved = count(coverage.loved_or_favorited);
    const tracks = tr.n(coverage.tracks_observed, "{count} track", "{count} tracks");
    lines.push(loved === undefined ? tr("Apple Music library: {tracks}", { tracks })
      : tr("Apple Music library: {tracks} · {loved} loved", { tracks, loved: tr.number(coverage.loved_or_favorited) }));
  }
  const source = profile?.listening_source ?? {};
  const collections = items(coverage.collection_sources).filter((collection) => collection.tracks > 0);
  if (collections.length > 1) lines.push(tr("{songs} across {count} services", { songs: tr.n(coverage.collection_tracks, "{count} song", "{count} songs"), count: collections.length }));
  for (const collection of collections) {
    if (collection.tracks > 0) lines.push(`${inline(collection.label)}: ${tr.n(collection.tracks, "{count} song", "{count} songs")}`);
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
  const range = earliest && latest ? tr("{first} to {last}", { first: earliest, last: latest }) : earliest || latest;
  if (providers.length || range) {
    lines.push([providers.length ? tr("{services} history", { services: providers.join(", ") }) : tr("History"), range]
      .filter(Boolean).join(" · "));
  }
  const captured = date(profile?.source?.captured_at);
  if (captured) lines.push(tr("Library as of {date}", { date: captured }));
  if (coverage.active_listener_assertions > 0) lines.push(tr.n(coverage.active_listener_assertions, "{count} choice you've made", "{count} choices you've made"));
  if (profile?.listener_model) {
    const saved = profile.listener_model;
    lines.splice(1, 0, saved.state === "missing" ? tr("Build a saved reading: /profile build")
      : saved.state === "stale" ? tr("Saved reading v{version} needs update: /profile build", { version: saved.sequence })
        : tr("Saved reading v{version}: /profile saved", { version: saved.sequence }));
  }
  return lines;
}

const sourceNames = {
  "Apple Music library preference": tr => tr("In your Apple Music library"),
  "Apple Music aggregate play count": tr => tr("Apple Music play count"),
};

function explicitKind(item) {
  if (["artist", "track"].includes(item?.entity_type)) return item.entity_type;
  if (item?.track_ref_id || item?.track_ref?.track_ref_id) return "track";
  if (inline(item?.name) && !item?.artist_credit) return "artist";
  return null;
}

/** Build a private, bounded review view from structured profile evidence. */
export function buildTasteProfileModel(profile = {}, tr = screenTranslator("en")) {
  const metrics = (item) => itemMetrics(profile.coverage?.events_with_played_duration === 0
    ? { ...item, listening_minutes: undefined } : item, tr);
  const withDetails = (source, details) => details.length ? tr("{source}: {details}", { source, details: details.join(" · ") }) : source;
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
        subtitle: kind === "track" ? inline(target.artistCredit) : tr("Artist"),
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
    add(item, item.entity_type, tr("Your choice"), [item.stance === "like" ? tr("You said: I like this") : tr("You said: keep this out"),
      ...(when ? [when] : []), ...(note ? [`"${note}"`] : [])].join(" · "), { assertion: true });
  }

  const recentDays = count(behavior.context?.recent_window_days);
  const recentSource = recentDays ? tr("Lately (last {count} days)", { count: recentDays }) : tr("Lately");
  for (const [field, kind, source] of [
    ["repeat_tracks", "track", tr("Most played")],
    ["enduring_artists", "artist", tr("Across the years")],
    ["recent_tracks", "track", recentSource],
    ["recent_artists", "artist", recentSource],
    ["rediscovery_tracks", "track", tr("Gone quiet")],
    ["historical_return_tracks", "track", tr("Came back")],
    ["back_to_back_tracks", "track", tr("Played in a row")],
  ]) {
    for (const item of items(behavior[field])) add(item, kind, source, withDetails(source, metrics(item)));
  }
  for (const item of items(behavior.time_capsule_tracks)) {
    const year = count(item?.capsule_year);
    const details = metrics({
      play_count: item?.year_play_count,
      engaged_play_count: item?.year_engaged_play_count,
      listening_minutes: item?.year_listening_minutes,
      explicit_skips: item?.year_explicit_skips,
    });
    add(item, "track", tr("Song of the year"), withDetails(year ? tr("Your song of {year}", { year: item.capsule_year }) : tr("Song of the year"), details));
  }
  for (const [field, kind, source] of [
    ["saved_tracks", "track", service => tr("Saved in your {service} library", { service })],
    ["playlist_anchors", "track", service => tr("On your {service} playlists", { service })],
    ["followed_artists", "artist", service => tr("Followed on {service}", { service })],
  ]) {
    for (const item of items(curated[field])) {
      const label = source(inline(item.source_label) || "Spotify");
      add(item, kind, label, withDetails(label, metrics(item)));
    }
  }
  for (const item of items(curated.avoids)) {
    const target = targetFor(item, item?.entity_type);
    if (target && !seenAssertions.has(subjectKey(target))) {
      add(item, item.entity_type, tr("Disliked in your music service"), tr("You disliked this in your music service. You can still change it here."));
    }
  }
  for (const [field, kind] of [["artists", "artist"], ["tracks", "track"]]) {
    for (const item of items(profile?.provider_signals?.[field])) {
      const rank = count(item?.best_rank);
      const details = [...(rank ? [tr("best at #{rank}", { rank })] : []), ...metrics(item)];
      add(item, kind, tr("Service top list"), withDetails(tr("In your service's top list"), details));
    }
  }
  for (const [field, fallback] of [["strong_preferences", tr("From your library")], ["familiarity", tr("Familiar from your library")]]) {
    for (const item of items(profile?.[field])) {
      const kind = explicitKind(item);
      if (!kind) continue;
      const target = targetFor(item, kind);
      if (!target) continue;
      const existing = subjects.get(subjectKey(target));
      if (item.evidence_id && existing?.evidence.some((evidence) => evidence.id === item.evidence_id)) continue;
      const source = sourceNames[inline(item.source)]?.(tr) ?? (inline(item.source) || fallback);
      const observed = date(item.observed_at);
      const details = [inline(item.signal).replace(/,? non-computed rating/u, ", rated"), ...metrics(item), ...(observed ? [tr("as of {date}", { date: observed })] : [])].filter(Boolean);
      add(item, kind, source, withDetails(source, details));
    }
  }
  for (const item of items(profile?.artist_facets)) {
    const target = targetFor(item, "artist");
    if (!target) continue;
    const existing = subjects.get(subjectKey(target));
    if (item.evidence_id && existing?.evidence.some((evidence) => evidence.id === item.evidence_id)) continue;
    add(item, "artist", tr("Library evidence"), Number.isSafeInteger(item.library_tracks)
      ? tr("Across your Apple library: {tracks} · {preferred} with positive preferences.", { tracks: tr.n(item.library_tracks, "{count} track", "{count} tracks"), preferred: tr.number(item.preferred_tracks) })
      : tr("Shows up through one of their tracks."));
  }

  for (const subject of subjects.values()) {
    if (subject.kind !== "track") continue;
    const artist = subjects.get(subjectKey({ entityType: "artist", label: subject.target.artistCredit }));
    if (artist?.stance !== "avoid") continue;
    subject.detailLines.unshift(subject.stance === "like"
      ? tr("You asked me to keep {artist} out. That still applies, even though you like this track.", { artist: artist.label })
      : tr("You asked me to keep {artist} out.", { artist: artist.label }));
    if (artist.evidenceId && !subject.evidence.some((evidence) => evidence.id === artist.evidenceId)) {
      subject.evidence.push({ id: artist.evidenceId, source: tr("Your choice for the artist") });
    }
  }

  return {
    summaryLines: overview(profile, tr),
    subjects: [...subjects.values()],
    emptyLines: [
      tr("Nothing to look at yet."),
      tr("Import your history or library and it will show up here."),
    ],
  };
}
