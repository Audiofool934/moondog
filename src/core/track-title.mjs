// A remaster, a live take or a guest credit names a recording of the same song, so knownness,
// deduplication and Moondog's suggestion ledger compare titles without these suffixes:
// " - 2011 Remaster", "(Remastered 2009)", " - Live", "(feat. X)", "[Deluxe]". A remix stays
// its own song.
const DASH_SUFFIX = /\s+[-\u2013\u2014]\s+[^-\u2013\u2014]*\b(?:remaster(?:ed)?|live|mono|stereo|single|radio edit|edit|version|demo|acoustic|bonus track|\d{4} mix)\b[^-\u2013\u2014]*$/iu;
const BRACKET_SUFFIX = /\s*[([][^()[\]]*\b(?:remaster(?:ed)?|live|feat\.?|ft\.?|featuring|with|deluxe|mono|stereo|version|edit|demo|acoustic|bonus track)(?:\b|(?<=\.))[^()[\]]*[)\]]$/iu;

export function normalizedTrackTitle(value) {
  let title = String(value ?? "").normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
  for (let previous = null; previous !== title;) {
    previous = title;
    const stripped = title.replace(DASH_SUFFIX, "").replace(BRACKET_SUFFIX, "").trim();
    // A title made only of a version word stays as it is.
    if (stripped) title = stripped;
  }
  return title;
}

export function normalizedArtistName(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

/** One song by one primary artist, whatever the recording's version suffix. */
export function trackMatchKey(title, artist) {
  const name = normalizedTrackTitle(title);
  const credit = normalizedArtistName(artist);
  return name && credit ? `${name}\u0000${credit}` : null;
}
