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

// Chinese, Japanese and Korean text, which has no spaces between words (or words
// that take particles), so a name in it is found as a substring.
const CJK_TEXT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// Folds case, width, Latin accents and punctuation, so "Beyoncé," and "beyonce" read alike.
// Kana voicing marks stay, because they change the word.
export function foldedWords(value) {
  return String(value ?? "").normalize("NFKD").replace(/[̀-ͯ]/gu, "").normalize("NFC")
    .toLocaleLowerCase("und").replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
}

export const isCjkText = (value) => CJK_TEXT.test(String(value ?? ""));

/**
 * Whether text names a name: as whole words in Latin text, as a substring in CJK text.
 * A name shorter than 2 characters after folding names nothing.
 */
export function textNames(text, name) {
  const wanted = foldedWords(name);
  if (Array.from(wanted.replace(/ /gu, "")).length < 2) return false;
  const haystack = foldedWords(text);
  return isCjkText(wanted) ? haystack.includes(wanted) : ` ${haystack} `.includes(` ${wanted} `);
}

/** Whether the listener's text names this song, by its title without version suffixes. */
export function textNamesTitle(text, title) {
  return textNames(text, normalizedTrackTitle(title));
}
