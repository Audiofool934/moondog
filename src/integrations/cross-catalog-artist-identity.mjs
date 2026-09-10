const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const recoverableCatalogStates = new Set(["ambiguous_artist", "not_found"]);

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value, maximum, field) {
  if (typeof value !== "string") fail(`The public ${field} is invalid.`);
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned || Array.from(cleaned).length > maximum) {
    fail(`The public ${field} is invalid.`);
  }
  return cleaned;
}

function normalizeForMatch(value) {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/["'‘’“”`]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function boundedDistinctIds(
  value,
  { field, itemField, maximum, pattern, minimum = 0, numeric = false },
) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(`The public ${field} are invalid.`);
  }
  const ids = value.map((id) => cleanText(id, 36, itemField));
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !pattern.test(id))
  ) {
    fail(`The public ${field} are invalid.`);
  }
  return ids.sort((left, right) =>
    left.localeCompare(right, "en", numeric ? { numeric: true } : undefined),
  );
}

function identityBase(state, candidateCount) {
  return {
    provider: "wikidata",
    method: "exact_label_or_alias",
    state,
    candidate_count: candidateCount,
    properties: ["P434", "P2850"],
    license: "CC0",
  };
}

function projectCrossCatalogArtistIdentity(value, artistName) {
  if (!isPlainObject(value)) {
    fail("The public cross-catalog artist identity is invalid.");
  }
  const requestedName = cleanText(artistName, 256, "artist name");
  const returnedName = cleanText(
    value.artist_name,
    256,
    "cross-catalog artist name",
  );
  if (normalizeForMatch(returnedName) !== normalizeForMatch(requestedName)) {
    fail("The public cross-catalog artist identity is invalid.");
  }
  const state = cleanText(value.state, 64, "cross-catalog identity state");
  if (!Array.isArray(value.candidates) || value.candidates.length > 8) {
    fail("The public cross-catalog artist candidates are invalid.");
  }
  const base = identityBase(state, value.candidates.length);
  if (state === "not_found" || state === "ambiguous") return base;
  if (state !== "resolved" || value.candidates.length === 0) {
    fail("The public cross-catalog identity state is invalid.");
  }
  const artistMbid = cleanText(
    value.artist_mbid,
    36,
    "MusicBrainz artist identity",
  ).toLowerCase();
  if (!uuidPattern.test(artistMbid)) {
    fail("The public MusicBrainz artist identity is invalid.");
  }
  const wikidataIds = boundedDistinctIds(value.wikidata_ids, {
    field: "Wikidata artist identities",
    itemField: "Wikidata artist identity",
    maximum: 8,
    minimum: 1,
    pattern: /^Q[1-9]\d{0,19}$/u,
    numeric: true,
  });
  const appleMusicArtistIds = boundedDistinctIds(
    value.apple_music_artist_ids,
    {
      field: "Apple Music artist identities",
      itemField: "Apple Music artist identity",
      maximum: 4,
      pattern: /^[1-9]\d{0,19}$/u,
      numeric: true,
    },
  );
  const resolved = {
    ...base,
    canonical_name: cleanText(
      value.canonical_name,
      256,
      "cross-catalog canonical artist name",
    ),
    musicbrainz_artist_id: artistMbid,
    wikidata_ids: wikidataIds,
  };
  if (appleMusicArtistIds.length === 0) {
    return { ...resolved, state: "apple_music_identity_missing" };
  }
  if (appleMusicArtistIds.length > 1) {
    return {
      ...resolved,
      state: "apple_music_identity_ambiguous",
      apple_music_artist_ids: appleMusicArtistIds,
    };
  }
  return {
    ...resolved,
    state: "resolved",
    apple_music_artist_id: appleMusicArtistIds[0],
  };
}

function isWikidataProviderError(error) {
  return (
    error?.name === "OpenMusicSimilarityError" &&
    error?.provider === "wikidata" &&
    typeof error?.code === "string" &&
    /^wikidata_[a-z0-9_]+$/u.test(error.code)
  );
}

function withIdentity(result, identity) {
  return {
    ...result,
    cross_catalog_identity: identity,
  };
}

export async function recoverArtistReleasesWithCrossCatalogIdentity({
  artistName,
  currentResult,
  catalog,
  identityResolver,
} = {}) {
  if (!isPlainObject(currentResult)) {
    fail("The public catalog result is invalid.");
  }
  if (
    !recoverableCatalogStates.has(currentResult.state) ||
    identityResolver === undefined ||
    identityResolver === null
  ) {
    return currentResult;
  }
  if (typeof identityResolver.resolveArtist !== "function") {
    fail("The public cross-catalog artist resolver is unavailable.");
  }
  let identity;
  try {
    identity = projectCrossCatalogArtistIdentity(
      await identityResolver.resolveArtist(artistName),
      artistName,
    );
  } catch (error) {
    if (!isWikidataProviderError(error)) throw error;
    return withIdentity(currentResult, identityBase("unavailable", 0));
  }
  if (identity.state !== "resolved") {
    return withIdentity(currentResult, identity);
  }
  if (typeof catalog?.findArtistReleasesByCatalogId !== "function") {
    fail("The public catalog identity lookup is unavailable.");
  }
  const linkedResult = await catalog.findArtistReleasesByCatalogId({
    artistCatalogId: identity.apple_music_artist_id,
    limit: 8,
  });
  if (!isPlainObject(linkedResult)) {
    fail("The public catalog identity result is invalid.");
  }
  if (linkedResult.state === "not_found") {
    return withIdentity(currentResult, {
      ...identity,
      state: "apple_music_identity_not_found",
    });
  }
  if (
    linkedResult.state !== "resolved" ||
    !isPlainObject(linkedResult.artist) ||
    String(linkedResult.artist.catalog_id) !== identity.apple_music_artist_id
  ) {
    return withIdentity(currentResult, {
      ...identity,
      state: "apple_music_identity_mismatch",
    });
  }
  return {
    ...linkedResult,
    query: {
      artist_name: cleanText(artistName, 256, "artist name"),
    },
    selection_basis: "wikidata_exact_label_or_alias_cross_catalog",
    cross_catalog_identity: identity,
  };
}
