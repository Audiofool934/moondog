// One Avoid check for every play path. Names fold case, accents and spacing, so "Drake " and
// "Drake" are one artist, and an artist Avoid matches a whole credit or any artist in it.

// Collaboration separators in artist credits. Full-width forms fold to these before splitting,
// but callers that do not fold text first can still split on them. A word separator needs a
// space before it, which a separator before it may already have taken.
export const ARTIST_CREDIT_SEPARATORS =
  /\s*(?:,|，|;|；|&|＆|\/|、|和|与)\s*|(?<=\s)(?:featuring|feat\.?|ft\.?|with)\s+/iu;

// "x" also joins artists ("Future x Drake"), but it ends some names ("Lil Nas X"). Only this
// check splits on it, because it also reads each run of artists as one name.
const separated = new RegExp(`(${ARTIST_CREDIT_SEPARATORS.source}|(?<=\\s)(?:x|×)\\s+)`, "iu");

// Features named in a title: "Song (feat. Drake)", "Song [with Drake]" or "Song feat. Drake".
const titleFeature =
  /\s*[（(【[]\s*(?:featuring|feat\.?|ft\.?|with)\s+([^）)】\]]+)[）)】\]]|\s+(?:-\s+)?(?:featuring|feat\.|ft\.)\s+(.+)$/giu;

export function avoidKey(value) {
  if (typeof value !== "string") return "";
  // Only Latin, Greek and Cyrillic accents fold: kana voicing marks change the word.
  return value.normalize("NFKD").replace(/[̀-ͯ]/gu, "")
    .toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

// A title without its features, and the artists those features name.
function titleParts(title) {
  const featured = [];
  const core = typeof title === "string"
    ? title.replace(titleFeature, (_whole, bracketed, trailing) => { featured.push(bracketed ?? trailing); return ""; })
    : title;
  return { core: avoidKey(core), featured };
}

// Every way to read free-text credits as one artist: the whole credit, each credited artist, and
// each run of them, so a band named "Simon & Garfunkel" stays one name inside a longer credit.
// A source's own list of artists names each one whole, so its names are not split.
function creditKeys(credit, artists = [], featured = []) {
  const listed = (Array.isArray(artists) ? artists : []).map(avoidKey).filter(Boolean);
  const keys = new Set(listed);
  if (listed.length) keys.add(avoidKey(credit));
  for (const name of [...(listed.length ? [] : [credit]), ...featured]) {
    const pieces = avoidKey(name).split(separated);
    for (let start = 0; start < pieces.length; start += 2) {
      for (let end = start; end < pieces.length; end += 2) {
        const key = pieces.slice(start, end + 1).join("").trim();
        if (key) keys.add(key);
      }
    }
  }
  keys.delete("");
  return keys;
}

const overlaps = (left, right) => [...left].some((key) => right.has(key));

/**
 * Builds the check from Avoid records ({ entity_type, label, artist_credit }). A track Avoid
 * matches its title, without any features, with any of its credited artists.
 */
export function createAvoidGate(avoids = []) {
  const artists = new Set();
  const tracks = new Map();
  for (const avoid of Array.isArray(avoids) ? avoids : []) {
    const label = avoidKey(avoid?.label);
    if (!label) continue;
    if (avoid.entity_type === "artist") artists.add(label);
    else if (avoid.entity_type === "track") {
      const { core, featured } = titleParts(avoid.label);
      const title = core || label;
      tracks.set(title, [...(tracks.get(title) ?? []), creditKeys(avoid.artist_credit, [], featured)]);
    }
  }
  const avoidsArtist = (keys) => overlaps(keys, artists);
  return {
    size: artists.size + tracks.size,
    avoidsArtist: (name, names = []) => avoidsArtist(creditKeys(name, names)),
    // A track as { title, artist_credit, artists }, where artists is a source's own list.
    avoidsTrack({ title, artist_credit: credit, artists: names } = {}) {
      const { core, featured } = titleParts(title);
      const keys = creditKeys(credit, names, featured);
      if (avoidsArtist(keys)) return true;
      return (tracks.get(core || avoidKey(title)) ?? []).some((avoided) =>
        avoided.size ? overlaps(avoided, keys) : keys.size === 0);
    },
  };
}

// The gate for the store's current data, rebuilt only when that data changes.
export function cachedAvoidGate(cache, version, readAvoids) {
  if (version === undefined || cache.version !== version) {
    cache.version = version;
    cache.gate = createAvoidGate(readAvoids());
  }
  return cache.gate;
}
