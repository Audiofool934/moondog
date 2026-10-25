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

// A letter or digit of a script that writes its words apart. A name must not start or end
// next to one of these when its own edge is one too; next to a CJK character, a space or
// punctuation, it may, so "Coldplay" is named in "我不想再听Coldplay了".
const SPACED_LETTER = /[[\p{L}\p{N}\p{M}]--[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]]/v;
const joined = (left, right) => left !== undefined && right !== undefined && SPACED_LETTER.test(left) && SPACED_LETTER.test(right);

/**
 * Whether text names a name. A script change (Latin next to CJK), a space or punctuation ends
 * a word, and between two Latin letters a name matches only as whole words.
 * A name shorter than 2 characters after folding names nothing.
 */
export function textNames(text, name) {
  const wanted = foldedWords(name);
  if (Array.from(wanted.replace(/ /gu, "")).length < 2) return false;
  const haystack = foldedWords(text);
  const first = Array.from(wanted)[0];
  const last = Array.from(wanted).at(-1);
  for (let at = haystack.indexOf(wanted); at >= 0; at = haystack.indexOf(wanted, at + 1)) {
    const before = Array.from(haystack.slice(0, at)).at(-1);
    const after = Array.from(haystack.slice(at + wanted.length))[0];
    if (!joined(before, first) && !joined(last, after)) return true;
  }
  return false;
}

/** Whether the listener's text names this song, by its title without version suffixes. */
export function textNamesTitle(text, title) {
  return textNames(text, normalizedTrackTitle(title));
}

// Articles that start band names in the supported languages: "Beatles" names "The Beatles".
const LEADING_ARTICLE = /^(?:the|an|a|los|las|el|la|les|le|l|die|der|das|il|lo|i|gli|os|as|o) (?=\S)/u;

/** Whether text names an artist, with or without a leading article. */
export function textNamesArtist(text, artist) {
  const name = foldedWords(artist);
  const bare = name.replace(LEADING_ARTICLE, "");
  // "The The" keeps its article: a bare article names nothing.
  return textNames(text, name) || (bare !== name && !LEADING_ARTICLE.test(`${bare} x`) && textNames(text, bare));
}

// A quoted name: straight or curly double or single quotes, corner brackets, title marks or
// guillemets. A straight or curly single quote inside a word is an apostrophe.
const QUOTED = [/"([^"]+)"/gu, /“([^“”]+)”/gu, /„([^„“”]+)[“”]/gu, /«([^«»]+)»/gu, /「([^「」]+)」/gu, /『([^『』]+)』/gu,
  /《([^《》]+)》/gu, /(?<![\p{L}\p{N}])'(?=(.+?)'(?![\p{L}\p{N}]))/gu, /‘(.+?)’(?![\p{L}\p{N}])/gu];

/** Whether text quotes this song's title, version suffixes aside. */
export function textQuotesTitle(text, title) {
  const wanted = foldedWords(normalizedTrackTitle(title));
  return Boolean(wanted) && QUOTED.some((pattern) => Array.from(String(text ?? "").matchAll(pattern))
    .some(([, quoted]) => foldedWords(normalizedTrackTitle(quoted)) === wanted));
}

/**
 * Whether the listener's text names this song as their own pick: its title with one of its
 * credited artists, or its title in quotes. A title alone ("play Pink Moon") is not enough,
 * because an open request shares words with titles ("a rainy day", "安静").
 */
export function textNamesSong(text, title, artists = []) {
  return textQuotesTitle(text, title) ||
    (textNamesTitle(text, title) && artists.some((artist) => textNamesArtist(text, artist)));
}
