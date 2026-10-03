// The limits below apply to delivery, never to the corpus being analyzed.
export const PROFILE_SECTIONS = Object.freeze([
  "overview", "history_artists", "history_tracks", "recent_artists", "recent_tracks",
  "history_years", "history_releases", "saved_tracks", "playlist_tracks", "saved_albums",
  "followed_artists", "provider_genres", "listener_preferences", "listener_avoids",
  "provider_evidence", "apple_tracks", "apple_artists", "apple_genres",
]);

const normalize = (value) => String(value ?? "").normalize("NFKC").toLocaleLowerCase("und");

export function profileExplorationInput(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !["section", "query", "offset", "limit", "sort"].includes(key))) {
    throw new TypeError("Profile exploration arguments are invalid");
  }
  const { section = "overview", query = "", offset = 0, limit = 12, sort = "ranked" } = value;
  if (!PROFILE_SECTIONS.includes(section) || typeof query !== "string" || query.length > 256 ||
    !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20 ||
    !["ranked", "least_played", "recent"].includes(sort)) {
    throw new TypeError("Profile exploration selection is invalid");
  }
  if (sort !== "ranked" && !["history_tracks", "history_artists", "recent_tracks", "recent_artists", "apple_tracks"].includes(section)) {
    throw new TypeError("This profile section supports ranked order only");
  }
  if (sort === "recent" && section === "apple_tracks") {
    throw new TypeError("Apple library play counts have no event chronology");
  }
  return { section, query: query.trim(), offset, limit, sort };
}

export function exploreProfileCatalog({ listening, apple, input }) {
  const { section, query, offset, limit, sort } = profileExplorationInput(input);
  const catalog = { ...listening?.sections, ...apple?.sections };
  const all = catalog[section] ?? [];
  const needle = normalize(query);
  let matches = all.filter((row) => !needle || [
    row.name, row.label, row.artist_credit, row.release, row.genre, row.year, row.evidence_kind,
    row.source_label, row.period, row.text, row.playlist_name, ...(row.playlist_names ?? []),
  ]
    .some((text) => normalize(text).includes(needle)));
  if (sort !== "ranked") {
    matches = matches.map((row, index) => ({ row, index })).sort((left, right) => {
      const order = sort === "least_played"
        ? (left.row.play_count ?? Number.MAX_SAFE_INTEGER) - (right.row.play_count ?? Number.MAX_SAFE_INTEGER)
        : String(right.row.last_played_at ?? "").localeCompare(String(left.row.last_played_at ?? ""));
      return order || left.index - right.index;
    }).map(({ row }) => row);
  }
  const items = matches.slice(offset, offset + limit).map((row) => {
    if (!needle || !row.playlist_names) return row;
    // Search every membership, and keep matching names in the bounded display.
    return { ...row, playlist_names: [...row.playlist_names].sort((left, right) =>
      Number(normalize(right).includes(needle)) - Number(normalize(left).includes(needle))) };
  });
  return structuredClone({
    schema_version: "profile-exploration/1",
    analysis_scope: "all_retained_supported_data",
    section,
    coverage: { ...listening?.coverage, ...apple?.coverage },
    sources: listening?.sources ?? [],
    context: listening?.context ?? {},
    section_note: section.startsWith("recent_")
      ? "Recent rankings use the retained-history reference date and recent_window_days, not today's date."
      : section === "history_releases"
        ? "Release depth includes releases meeting release_minimum_distinct_tracks. It does not prove album completion."
        : section === "provider_genres"
          ? "Named provider genre labels only. Unresolved labels remain in provider_evidence."
          : "Complete selected evidence section, before search and pagination.",
    sections: Object.entries(catalog).map(([name, rows]) => ({ name, total: rows.length })),
    total: all.length,
    matched: matches.length,
    offset,
    next_offset: offset + items.length < matches.length ? offset + items.length : null,
    items,
    limitations: [
      "All retained supported records contribute before search, sorting, or pagination. A page is a selection, not the complete profile.",
      "History describes attention; library membership, saved tracks, ratings, provider labels, and explicit listener choices are separate signals.",
      "Spotify private-session plays are excluded from behavioral analysis. Superseded export overlaps are not counted again.",
      "Apple Music is a library snapshot. Its aggregate play counts are not dated plays and must not be added to Spotify event totals.",
      "Apple preferred-track counts exclude active listener Avoids. Original library membership, ratings, and love states remain visible.",
      "Provider genre labels describe catalog metadata, not measured sound. Absence from an export is not a dislike.",
    ],
  });
}
