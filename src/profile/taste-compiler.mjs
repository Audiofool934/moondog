// The taste compiler: what shapes a track Moondog makes, checked against the listener's evidence
// before any model hears it (docs/MUSIC_DECENTRALIZATION.md, "The profile as a taste compiler").
// The agent translates taste into sound descriptors; the host keeps only those it can trace to a
// saved reading, a Like, recent attention, the moment or the listener's own request, and none that
// names an artist or a song. The descriptors depend on no model; an adapter per model writes the prompt.
import { ARTIST_CREDIT_SEPARATORS, avoidKey } from "../core/listener-avoids.mjs";
import { normalizedTrackTitle, textNames, textNamesArtist } from "../core/track-title.mjs";

export const DESCRIPTOR_FACETS = Object.freeze(["genre", "instrument", "texture", "mood", "rhythm"]);
export const DESCRIPTOR_SOURCES = Object.freeze(["reading", "choice", "recent", "moment", "request"]);
export const DESCRIPTOR_LIMITS = Object.freeze({ total: 12, genre: 3, instrument: 5, words: 5, characters: 40 });
export const BPM_RANGE = Object.freeze({ min: 40, max: 220 });

// Words for singing: the generator makes instrumentals only, and asking for a voice makes it worse.
const VOCAL_WORDS = /\b(?:vocals?|vocalists?|singing|singers?|sung|voices?|choirs?|chorus|rap|rapping|lyrics?|spoken)\b/iu;
// Letters, digits, spaces and the joiners of ordinary descriptors; no quotes, brackets or tags.
const DESCRIPTOR_SHAPE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} '&/-]*$/u;
const TITLE_SHAPE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} ',.&/:-]*$/u;

const clean = (value) => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();

// Words for a time of day, and the parts of the listener's day each fits. A term the agent credits
// to the moment that names another time came from the listener's words ("tonight"), not the clock.
const TIMES_OF_DAY = [
  [/\b(?:night|nighttime|nocturnal|midnight|late-night|after hours|small hours|moonlit)\b/u, ["late_night", "evening"]],
  [/\b(?:dusk|sunset|twilight|evening)\b/u, ["evening"]],
  [/\b(?:dawn|sunrise|daybreak)\b/u, ["early_morning"]],
  [/\b(?:morning|breakfast)\b/u, ["early_morning", "morning"]],
  [/\b(?:afternoon|midday|noon)\b/u, ["afternoon"]],
];
const otherTimeOfDay = (term, partOfDay) => TIMES_OF_DAY.some(([words, parts]) => words.test(term) && !parts.includes(partOfDay));

/**
 * The name a descriptor or a title carries, or null. artists and titles are the ones the listener
 * chose or plays now, matched anywhere in the text. historyArtists are every artist they ever
 * played: many short ones are ordinary words ("Low", "Air"), so a one-word name under five letters
 * counts only as the whole text. historyTitles are their songs and albums of two words or more; a
 * one-word title ("Home", "Rain") is too often an ordinary word to keep out. A name the history does not know can still pass; the shape
 * limits keep a descriptor to a few plain words.
 */
export function namedBy(text, { artists = [], titles = [], historyArtists = [], historyTitles = [] } = {}) {
  for (const artist of artists) if (textNamesArtist(text, artist)) return artist;
  for (const title of [...titles, ...historyTitles]) if (textNames(text, title)) return title;
  const whole = avoidKey(text);
  for (const artist of historyArtists) {
    const short = !/\s/u.test(artist.trim()) && Array.from(artist.trim()).length < 5;
    if (short ? avoidKey(artist) === whole : textNamesArtist(text, artist)) return artist;
  }
  return null;
}

/**
 * Compiles one request to make a track. requested is what the agent proposed:
 * { descriptors: [{ term, facet, source, from? }], bpm?, bpm_source?, title? }. context is what
 * the host holds: { claim(id) → claim or null, revisionId, likes, avoids, recentArtists, recentWindow,
 * historyArtists, historyTitles, avoidsName(name), moment, request }. Returns { usable, descriptors, dropped, bpm, title }; nothing is made unless usable.
 */
export function compileTaste(requested, context) {
  const likes = context.likes ?? [];
  const avoids = context.avoids ?? [];
  // Every Avoid's names stay out of the prompt. As a source, an artist Avoid keeps out the artist,
  // and a song Avoid only that song, as the play paths' gate reads them: a Like of the song's artist still counts.
  const avoidLabels = avoids.flatMap((choice) => [choice.name, choice.artist].filter(Boolean));
  const artistAvoids = avoids.filter((choice) => choice.subject !== "track").map((choice) => choice.name).filter(Boolean);
  const songAvoids = avoids.filter((choice) => choice.subject === "track" && choice.name);
  const avoided = (name) => Boolean(name) && (artistAvoids.some((label) => avoidKey(label) === avoidKey(name)) ||
    songAvoids.some((song) => avoidKey(song.name) === avoidKey(name)) || context.avoidsName?.(name) === true);
  const namesAvoid = (text) => artistAvoids.some((label) => textNamesArtist(text, label)) ||
    songAvoids.some((song) => textNames(text, song.name) && (!song.artist || textNamesArtist(text, song.artist)));
  const names = {
    artists: [...new Set([...avoidLabels, ...likes.flatMap((like) => [like.subject === "artist" ? like.name : like.artist]),
      ...(context.recentArtists ?? []).map((artist) => artist.name)].filter(Boolean))],
    titles: [...new Set([...likes, ...avoids].filter((choice) => choice.subject === "track").map((choice) => choice.name).filter(Boolean))],
    historyArtists: [...new Set(context.historyArtists ?? [])].filter((name) => typeof name === "string" && name.trim()),
    historyTitles: [...new Set(context.historyTitles ?? [])].filter((title) => typeof title === "string" && /\S\s+\S/u.test(title.trim())),
  };
  // A request that names an artist or a song the listener keeps out cannot shape the sound.
  const requestAvoided = typeof context.request === "string" && namesAvoid(context.request);
  const kept = [];
  const dropped = [];
  const drop = (term, reason, extra = {}) => dropped.push({ term, reason, ...extra });
  const facetCount = (facet) => kept.filter((descriptor) => descriptor.facet === facet).length;

  // A term that lists several sounds ("hushed, unhurried") is several descriptors with one source.
  const proposals = (Array.isArray(requested?.descriptors) ? requested.descriptors : []).flatMap((proposed) => {
    const parts = clean(proposed?.term).split(/\s*[,;，；、]\s*/u).filter(Boolean);
    return parts.length > 1 ? parts.map((part) => ({ ...proposed, term: part })) : [proposed];
  }).slice(0, DESCRIPTOR_LIMITS.total * 2);
  for (const proposed of proposals) {
    const term = clean(proposed?.term).toLocaleLowerCase("und");
    const facet = proposed?.facet;
    const kind = proposed?.source;
    const from = clean(proposed?.from);
    if (!term || !DESCRIPTOR_FACETS.includes(facet) || !DESCRIPTOR_SOURCES.includes(kind)) { drop(term, "invalid"); continue; }
    if (Array.from(term).length > DESCRIPTOR_LIMITS.characters || term.split(" ").length > DESCRIPTOR_LIMITS.words || !DESCRIPTOR_SHAPE.test(term)) {
      drop(term, "shape"); continue;
    }
    if (VOCAL_WORDS.test(term)) { drop(term, "vocals"); continue; }
    const name = namedBy(term, names);
    if (name) { drop(term, avoided(name) ? "avoid" : "name"); continue; }
    if (kept.some((descriptor) => descriptor.term === term)) { drop(term, "repeated"); continue; }
    if (kept.length >= DESCRIPTOR_LIMITS.total || (DESCRIPTOR_LIMITS[facet] !== undefined && facetCount(facet) >= DESCRIPTOR_LIMITS[facet])) {
      drop(term, "too_many"); continue;
    }
    let source;
    if (kind === "reading") {
      const claim = from ? context.claim?.(from) : null;
      if (!claim) { drop(term, "not_a_saved_finding"); continue; }
      // A finding about an artist the listener keeps out is no source for the sound they want.
      if (claim.stance === "avoid" || namesAvoid(claim.statement ?? "")) { drop(term, "avoid"); continue; }
      source = { kind, claim_id: claim.claim_id, ...(context.revisionId ? { revision_id: context.revisionId } : {}) };
    } else if (kind === "choice") {
      if (avoided(from)) { drop(term, "avoid"); continue; }
      const like = likes.find((choice) => [choice.name, choice.subject === "track" ? null : choice.artist].some((label) => label && avoidKey(label) === avoidKey(from)));
      if (!like) { drop(term, "not_a_like"); continue; }
      source = { kind, stance: "like", subject: like.subject, label: like.name, ...(like.artist ? { artist: like.artist } : {}) };
    } else if (kind === "recent") {
      if (avoided(from)) { drop(term, "avoid"); continue; }
      const artist = (context.recentArtists ?? []).find((entry) => avoidKey(entry.name) === avoidKey(from));
      if (!artist) { drop(term, "not_in_recent_attention"); continue; }
      source = { kind, artist: artist.name, ...(context.recentWindow ?? {}) };
    } else if (kind === "moment" && !otherTimeOfDay(term, context.moment?.part_of_day)) {
      if (!context.moment) { drop(term, "no_clock"); continue; }
      source = { kind, ...context.moment };
    } else {
      if (requestAvoided) { drop(term, "avoid"); continue; }
      source = { kind: "request" };
    }
    kept.push({ term, facet, source });
  }
  // A rhythm alone describes no music; nothing is made, and the result says what was dropped and why.
  const usable = kept.some((descriptor) => ["genre", "instrument", "mood", "texture"].includes(descriptor.facet));
  const bpm = Number.isInteger(requested?.bpm) && requested.bpm >= BPM_RANGE.min && requested.bpm <= BPM_RANGE.max ? requested.bpm : null;
  const bpmSource = bpm && ["request", "moment", "reading"].includes(requested?.bpm_source) ? requested.bpm_source : bpm ? "moondog" : null;
  return { usable, descriptors: kept, dropped, bpm, ...(bpm ? { bpm_source: bpmSource } : {}), title: trackTitle(requested?.title, kept, names) };
}

// Moondog names its own records. A proposed title stays when it is short, plain and names no one;
// otherwise the title is the sound in a few words.
function trackTitle(proposed, descriptors, names) {
  const title = clean(proposed);
  if (title && Array.from(title).length <= 60 && TITLE_SHAPE.test(title) && !namedBy(title, names) && !VOCAL_WORDS.test(title)) return title;
  const pick = (facets) => descriptors.find((descriptor) => facets.includes(descriptor.facet))?.term;
  const words = [pick(["mood"]) ?? pick(["texture"]), pick(["genre"]) ?? pick(["instrument"])].filter(Boolean);
  const text = [...new Set(words)].join(" ");
  return text ? text[0].toUpperCase() + text.slice(1) : "Untitled";
}

/** The names in played tracks, for the name check: each credit whole and split, and each song and album title. */
export function listenedNames(tracks) {
  const artists = new Set();
  const titles = new Set();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const credit = typeof track?.artist_credit === "string" ? track.artist_credit.trim() : "";
    if (credit) {
      artists.add(credit);
      for (const part of credit.split(ARTIST_CREDIT_SEPARATORS)) if (part?.trim()) artists.add(part.trim());
    }
    for (const title of [normalizedTrackTitle(track?.title), typeof track?.release === "string" ? track.release : track?.release?.title]) {
      if (typeof title === "string" && title.trim()) titles.add(title.trim());
    }
  }
  return { artists: [...artists], titles: [...titles] };
}

/** What the receipt and the tool result say shaped the sound, in order of the profile's layers. */
export function tasteSources(descriptors) {
  const order = ["reading", "choice", "recent", "moment", "request"];
  return order.filter((kind) => descriptors.some((descriptor) => descriptor.source.kind === kind));
}
