import { sanitizeTerminalText } from "./format-output.mjs";
import { recoverArtistReleasesWithCrossCatalogIdentity } from "../../integrations/cross-catalog-artist-identity.mjs";

const usage =
  "Usage: moondog catalog latest-single --artist <name> [--artist-page <Apple Music artist URL> | --known-release <title> | --from <spotify-history.zip>] [--json].";

export function catalogHelpText() {
  return `# Moondog public catalog

- \`moondog catalog latest-single --artist <name> [--artist-page <Apple Music artist URL> | --known-release <title> | --from <spotify-history.zip>] [--json]\` - read the newest already released single from the Apple Music US storefront without a model

Use \`--artist-page\` to select one public artist page returned by an ambiguous result.
Use \`--known-release\` only to distinguish artists that share the same exact name.
Use \`--from\` to derive up to three withheld release hints from one explicitly supplied Spotify history ZIP without persistence.
When Apple name search remains ambiguous or finds no exact name, Moondog can follow one exact Wikidata label or alias through linked MusicBrainz and Apple Music artist identities.
The result includes the retrieval time and storefront boundary, makes no provider write, and does not send a personal profile or private archive.`;
}

function fail(message = usage) {
  throw new Error(message);
}

function cleanText(value, maximum, field) {
  if (typeof value !== "string") fail(`The catalog ${field} is invalid.`);
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned || Array.from(cleaned).length > maximum) {
    fail(`The catalog ${field} is invalid.`);
  }
  return cleaned;
}

function optionalText(value, maximum, field) {
  return value === undefined || value === null
    ? undefined
    : cleanText(value, maximum, field);
}

function appleCatalogUrl(value, field) {
  const cleaned = optionalText(value, 2_048, field);
  if (!cleaned) return undefined;
  let url;
  try {
    url = new URL(cleaned);
  } catch {
    fail(`The catalog ${field} is invalid.`);
  }
  if (
    url.protocol !== "https:" ||
    !new Set(["music.apple.com", "itunes.apple.com"]).has(url.hostname)
  ) {
    fail(`The catalog ${field} is invalid.`);
  }
  return url.toString();
}

function artistCatalogIdFromPage(value) {
  const cleaned = cleanText(value, 2_048, "artist page");
  let url;
  try {
    url = new URL(cleaned);
  } catch {
    fail("The catalog artist page is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !new Set(["music.apple.com", "itunes.apple.com"]).has(url.hostname)
  ) {
    fail("The catalog artist page is invalid.");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const artistIndex = segments.indexOf("artist");
  const rawCatalogId = segments.at(-1)?.replace(/^id(?=\d)/u, "");
  if (
    artistIndex < 0 ||
    artistIndex >= segments.length - 1 ||
    !/^\d{1,20}$/u.test(rawCatalogId ?? "")
  ) {
    fail("The catalog artist page is invalid.");
  }
  return rawCatalogId;
}

function parseLatestSingleArguments(args) {
  const values = args.slice(1);
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (!new Set(["--artist", "--artist-page", "--known-release"]).has(option)) {
      fail(usage);
    }
    if (value === undefined || value.startsWith("--")) {
      fail(`The ${option} option requires a value.`);
    }
    const field = option === "--artist"
      ? "artistName"
      : option === "--artist-page"
        ? "artistPage"
        : "knownRelease";
    if (parsed[field] !== undefined) {
      fail(`The ${option} option may be provided only once.`);
    }
    parsed[field] = value;
  }
  if (parsed.artistName === undefined) {
    fail("The --artist option is required.");
  }
  return parsed;
}

function projectSource(value) {
  if (
    !value ||
    value.provider !== "apple_music" ||
    value.catalog !== "itunes_search_api" ||
    value.storefront !== "US"
  ) {
    fail("The public catalog source is invalid.");
  }
  const retrievedAt = cleanText(value.retrieved_at, 64, "retrieval time");
  if (!Number.isFinite(Date.parse(retrievedAt))) {
    fail("The public catalog retrieval time is invalid.");
  }
  return {
    provider: "apple_music",
    catalog: "itunes_search_api",
    storefront: "US",
    retrieved_at: retrievedAt,
    coverage: cleanText(value.coverage, 256, "coverage boundary"),
  };
}

function projectArtist(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("The catalog artist is invalid.");
  }
  const artist = {
    name: cleanText(value.name, 256, "artist name"),
  };
  const catalogUrl = appleCatalogUrl(value.catalog_url, "artist URL");
  if (catalogUrl) artist.catalog_url = catalogUrl;
  return artist;
}

function projectRelease(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("The catalog release is invalid.");
  }
  const releaseType = cleanText(value.release_type, 16, "release type");
  if (!new Set(["single", "ep", "album"]).has(releaseType)) {
    fail("The catalog release type is invalid.");
  }
  const releaseDate = cleanText(value.release_date, 10, "release date");
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(releaseDate) ||
    !Number.isFinite(Date.parse(`${releaseDate}T00:00:00.000Z`))
  ) {
    fail("The catalog release date is invalid.");
  }
  const release = {
    title: cleanText(value.title, 512, "release title"),
    artist_name: cleanText(value.artist_name, 256, "release artist"),
    release_type: releaseType,
    release_date: releaseDate,
  };
  const catalogUrl = appleCatalogUrl(value.catalog_url, "release URL");
  if (catalogUrl) release.catalog_url = catalogUrl;
  return release;
}

function projectCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("The catalog artist candidate is invalid.");
  }
  return {
    artist: projectArtist(value.artist),
    recent_releases: Array.isArray(value.recent_releases)
      ? value.recent_releases.slice(0, 3).map(projectRelease)
      : [],
  };
}

function safeCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 500_000) {
    fail(`The local archive ${field} is invalid.`);
  }
  return value;
}

function projectArchiveHints(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("The local archive evidence is invalid.");
  }
  const sourceFormat = cleanText(
    value.source_format,
    128,
    "archive source format",
  );
  if (
    !new Set([
      "spotify_account_data_streaming_history_v1",
      "spotify_extended_streaming_history_music_v1",
    ]).has(sourceFormat)
  ) {
    fail("The local archive source format is invalid.");
  }
  if (!Array.isArray(value.release_titles) || value.release_titles.length > 3) {
    fail("The local archive release hints are invalid.");
  }
  const releaseTitles = value.release_titles.map((title) =>
    cleanText(title, 512, "archive release hint"),
  );
  const normalizedTitles = releaseTitles.map((title) =>
    title.normalize("NFKC").toLocaleLowerCase("und"),
  );
  if (new Set(normalizedTitles).size !== releaseTitles.length) {
    fail("The local archive release hints are invalid.");
  }
  safeCount(value.exact_artist_track_count, "exact-artist track count");
  safeCount(value.exact_artist_event_count, "exact-artist event count");
  return {
    releaseTitles,
    publicEvidence: {
      source_format: sourceFormat,
      private_values_withheld: true,
    },
  };
}

function boundedResult(
  raw,
  {
    artistName,
    artistPage,
    knownRelease,
    archiveHints,
    releaseHintsConsidered = 0,
    crossCatalogIdentity,
  },
) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("The public catalog result is invalid.");
  }
  const source = projectSource(raw.source);
  const base = {
    command: "catalog.latest_single",
    state: cleanText(raw.state, 32, "result state"),
    source,
    query: {
      artist_name: cleanText(artistName, 256, "artist name"),
      artist_page_provided: artistPage !== undefined,
      known_release_provided: knownRelease !== undefined,
      local_archive_provided: archiveHints !== undefined,
      cross_catalog_identity_attempted: crossCatalogIdentity !== undefined,
    },
    model_required: false,
    private_profile_read: false,
    private_profile_sent: false,
    private_archive_read: archiveHints !== undefined,
    private_archive_sent: false,
    external_effects: "none",
  };
  if (crossCatalogIdentity) {
    base.cross_catalog_identity = crossCatalogIdentity;
  }
  if (archiveHints) {
    base.local_archive_evidence = {
      ...archiveHints.publicEvidence,
      release_hints_considered: releaseHintsConsidered,
      selected_release_withheld:
        raw.state === "resolved" &&
        raw.selection_basis === "exact_artist_name_and_known_release",
      persisted: false,
    };
  }
  if (raw.state === "not_found") return base;
  if (raw.state === "artist_identity_mismatch") {
    return {
      ...base,
      artist: projectArtist(raw.artist),
    };
  }
  if (raw.state === "ambiguous_artist") {
    const candidates = Array.isArray(raw.candidates)
      ? raw.candidates.slice(0, 4).map(projectCandidate)
      : [];
    return {
      ...base,
      candidate_count: candidates.length,
      candidates,
    };
  }
  if (raw.state !== "resolved") fail("The public catalog result state is invalid.");
  const artist = projectArtist(raw.artist);
  const rawSelectionBasis = cleanText(
    raw.selection_basis,
    64,
    "identity selection basis",
  );
  const selectionBasis =
    crossCatalogIdentity?.state === "resolved" &&
    rawSelectionBasis === "explicit_artist_catalog_identity"
      ? "wikidata_exact_label_or_alias_cross_catalog"
      : archiveHints && rawSelectionBasis === "exact_artist_name_and_known_release"
        ? "exact_artist_name_and_withheld_local_history_release"
        : rawSelectionBasis;
  if (raw.latest_released_single === null) {
    return {
      ...base,
      state: "no_released_single",
      artist,
      identity_selection_basis: selectionBasis,
    };
  }
  if (raw.latest_released_single === undefined) {
    fail("The catalog did not provide an explicit latest released single.");
  }
  const latestReleasedSingle = projectRelease(raw.latest_released_single);
  if (
    latestReleasedSingle.release_type !== "single" ||
    latestReleasedSingle.release_date > source.retrieved_at.slice(0, 10)
  ) {
    fail("The explicit latest released single is invalid.");
  }
  return {
    ...base,
    artist,
    identity_selection_basis: selectionBasis,
    latest_released_single: latestReleasedSingle,
  };
}

function formatCandidate(candidate, index) {
  const releases = candidate.recent_releases
    .map((release) => `${release.title} (${release.release_date})`)
    .join(", ");
  const catalogPage = candidate.artist.catalog_url
    ? `; catalog page: ${candidate.artist.catalog_url}`
    : "";
  return `- Candidate ${index + 1}: ${candidate.artist.name}${catalogPage}${
    releases ? `; recent public releases: ${releases}` : ""
  }`;
}

function formatCrossCatalogIdentity(identity) {
  if (identity.state === "resolved") {
    return `Cross-catalog identity: one exact Wikidata label or alias linked ${identity.canonical_name} through MusicBrainz ${identity.musicbrainz_artist_id} to Apple Music ${identity.apple_music_artist_id}.`;
  }
  if (identity.state === "not_found") {
    return "Cross-catalog identity: Wikidata found no exact label or alias carrying a MusicBrainz artist identity, so Moondog did not guess.";
  }
  if (identity.state === "ambiguous") {
    return "Cross-catalog identity: the exact Wikidata label or alias maps to more than one MusicBrainz artist identity, so Moondog did not guess.";
  }
  if (identity.state === "apple_music_identity_missing") {
    return "Cross-catalog identity: the exact Wikidata label or alias resolves to one MusicBrainz artist identity but has no linked Apple Music artist identity, so Moondog did not guess.";
  }
  if (identity.state === "apple_music_identity_ambiguous") {
    return "Cross-catalog identity: the exact Wikidata label or alias has more than one linked Apple Music artist identity, so Moondog did not guess.";
  }
  if (identity.state === "apple_music_identity_not_found") {
    return "Cross-catalog identity: the uniquely linked Apple Music artist identity was not found in the US storefront, so Moondog retained the original catalog result.";
  }
  if (identity.state === "apple_music_identity_mismatch") {
    return "Cross-catalog identity: the Apple lookup did not return the uniquely linked artist identity, so Moondog retained the original catalog result.";
  }
  return "Cross-catalog identity: Wikidata was unavailable, so Moondog retained the original catalog result instead of guessing.";
}

function formatResult(result) {
  const lines = ["Apple Music US public catalog"];
  if (result.state === "resolved") {
    lines.push(
      `${result.artist.name} latest released single: ${result.latest_released_single.title}`,
      `Released: ${result.latest_released_single.release_date}`,
    );
    if (result.latest_released_single.catalog_url) {
      lines.push(`Catalog page: ${result.latest_released_single.catalog_url}`);
    }
    lines.push(`Identity: ${result.identity_selection_basis}.`);
  } else if (result.state === "ambiguous_artist") {
    lines.push(
      `The catalog returned multiple exact-name artist candidates (${result.candidate_count}), so Moondog did not guess.`,
      ...result.candidates.map(formatCandidate),
      "Next: rerun with --artist-page <one catalog page shown above>, or --known-release <one known title>.",
    );
  } else if (result.state === "artist_identity_mismatch") {
    lines.push(
      `The supplied artist page resolves to ${result.artist.name}, not ${result.query.artist_name}, so Moondog did not continue.`,
      result.artist.catalog_url
        ? `Catalog page: ${result.artist.catalog_url}`
        : null,
    );
  } else if (result.state === "not_found") {
    lines.push(
      result.cross_catalog_identity?.state === "resolved"
        ? `The linked Apple Music artist identity was not found in the US storefront for ${result.query.artist_name}.`
        : `No exact artist match was found for ${result.query.artist_name}.`,
    );
  } else {
    lines.push(
      `No already released single was found for ${result.artist.name} in the bounded catalog lookup.`,
    );
  }
  if (result.cross_catalog_identity) {
    lines.push(formatCrossCatalogIdentity(result.cross_catalog_identity));
  }
  lines.push(
    `Retrieved: ${result.source.retrieved_at}`,
    `Boundary: ${result.source.coverage}`,
    result.private_archive_read
      ? "Privacy: This command read only the explicitly supplied Spotify history ZIP in memory, persisted none of it, and sent neither archive content nor derived release titles."
      : "Privacy: This command did not read or send a personal profile.",
    result.private_archive_read
      ? "Moondog's persisted personal profile was not read."
      : null,
    "No model provider was used. No provider write occurred.",
  );
  return lines
    .filter((line) => line !== null)
    .map((line) => sanitizeTerminalText(line))
    .join("\n");
}

export async function runCatalogCommand({
  args = [],
  json = false,
  archivePath,
  deriveArchiveHints,
  catalog,
  identityResolver,
  stdout = process.stdout,
} = {}) {
  if (
    (args.length === 0 || (args.length === 1 && args[0] === "help")) &&
    archivePath === undefined
  ) {
    stdout.write(`${catalogHelpText()}\n`);
    return { state: "help" };
  }
  if (args[0] !== "latest-single") fail(usage);
  const parsed = parseLatestSingleArguments(args);
  const identityHintCount = [
    parsed.artistPage,
    parsed.knownRelease,
    archivePath,
  ].filter((value) => value !== undefined).length;
  if (identityHintCount > 1) {
    fail("Use only one identity hint: --artist-page, --known-release, or --from.");
  }
  const artistCatalogId = parsed.artistPage === undefined
    ? undefined
    : artistCatalogIdFromPage(parsed.artistPage);
  if (!catalog || typeof catalog.findArtistReleases !== "function") {
    fail("The public catalog is unavailable.");
  }
  let archiveHints;
  if (archivePath !== undefined) {
    if (typeof deriveArchiveHints !== "function") {
      fail("The local Spotify archive reader is unavailable.");
    }
    archiveHints = projectArchiveHints(
      await deriveArchiveHints({
        archivePath,
        artistName: parsed.artistName,
        maximumHints: 3,
      }),
    );
  }
  const releaseHints = parsed.knownRelease
    ? [parsed.knownRelease]
    : (archiveHints?.releaseTitles ?? []);
  const attempts = releaseHints.length > 0 ? releaseHints : [undefined];
  let raw;
  let releaseHintsConsidered = 0;
  for (const releaseHint of attempts) {
    if (releaseHint !== undefined) releaseHintsConsidered += 1;
    raw = await catalog.findArtistReleases({
      artistName: parsed.artistName,
      ...(artistCatalogId === undefined ? {} : { artistCatalogId }),
      ...(releaseHint === undefined ? {} : { knownRelease: releaseHint }),
      limit: 8,
    });
    if (raw?.state !== "ambiguous_artist") break;
  }
  if (parsed.artistPage === undefined) {
    raw = await recoverArtistReleasesWithCrossCatalogIdentity({
      artistName: parsed.artistName,
      currentResult: raw,
      catalog,
      identityResolver,
    });
  }
  const crossCatalogIdentity = raw.cross_catalog_identity;
  const result = boundedResult(raw, {
    ...parsed,
    archiveHints,
    releaseHintsConsidered,
    crossCatalogIdentity,
  });
  stdout.write(`${json ? JSON.stringify(result, null, 2) : formatResult(result)}\n`);
  return result;
}
