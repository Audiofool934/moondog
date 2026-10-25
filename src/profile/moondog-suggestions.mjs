import { normalizedArtistName, trackMatchKey } from "../core/track-title.mjs";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// A stored play is one Moondog started when it is the same recording as a suggestion (the same
// Spotify track or ISRC) or the same song by title and primary artist, and it lands from 60
// seconds before the request to six hours after it: long enough for a queued batch to play out,
// short enough that a later return is the listener's own. A play's time is when it ended, so one
// that ended before the request was the listener's; the 60 seconds only absorb clock skew. A
// matching play after the window is the listener's choice and marks the suggestion adopted. The
// match runs whenever the profile is read, so a later history import is matched the same way.
export const SUGGESTION_WINDOW = Object.freeze({ beforeMs: 60_000, afterMs: 6 * HOUR_MS });

export const SUGGESTION_SERVICES = Object.freeze(["spotify", "netease", "apple_music"]);

// One artist's name can hold a separator ("AC/DC", "Simon & Garfunkel", "Tyler, The Creator"),
// so a bare credit is tried whole, then by its comma parts, then by every part.
function creditSplits(credit) {
  const whole = String(credit ?? "").trim();
  const split = (pattern) => whole.split(pattern).map((name) => name.trim()).filter(Boolean);
  return [[whole].filter(Boolean), split(/[,;]/u), split(/\s*(?:,|&|;|\/|\bfeat\.?|\bfeaturing\b)\s*/iu)];
}

const creditNames = (credit) => [...new Set(creditSplits(credit).flat())];

// The names a track may be stored under: its first artist, or each reading of a bare credit's first one.
function primaryArtists(track) {
  if (Array.isArray(track?.artists) && typeof track.artists[0] === "string") return [track.artists[0]];
  if (Array.isArray(track?.artist_credits)) return track.artist_credits[0]?.name ? [track.artist_credits[0].name] : [];
  return [...new Set(creditSplits(track?.artist_credit).map((names) => names[0]).filter(Boolean))];
}

/** One song by its primary artist, the same for every version of it; a bare credit can give more than one. */
export function songKeys(track) {
  return [...new Set(primaryArtists(track).map((artist) => trackMatchKey(track?.title, artist)).filter(Boolean))];
}

const releaseKey = (track) => trackMatchKey(typeof track?.release === "string" ? track.release : track?.release?.title,
  primaryArtists(track)[0]);

/** The ways a stored track can match a suggestion: its Spotify track, its ISRC, its song, its album. */
export function playedTrackIdentities(track) {
  const identities = [];
  for (const ref of Array.isArray(track?.external_refs) ? track.external_refs : []) {
    if (ref?.system === "spotify" && ref.entity_type === "spotify.track" && typeof ref.external_id === "string") {
      identities.push(`spotify:track:${ref.external_id}`);
    }
  }
  if (typeof track?.isrc === "string") identities.push(`isrc:${track.isrc.toUpperCase()}`);
  for (const key of songKeys(track)) identities.push(`key:${key}`);
  const release = releaseKey(track);
  if (release) identities.push(`release:${release}`);
  return identities;
}

export function suggestionIdentities(suggestion) {
  return [...new Set([
    suggestion.provider_track_id,
    suggestion.isrc ? `isrc:${suggestion.isrc}` : null,
    suggestion.track_key ? `key:${suggestion.track_key}` : null,
    ...(suggestion.track_key ? songKeys({ title: suggestion.title, artist_credit: suggestion.artist_credit }).map((key) => `key:${key}`) : []),
    suggestion.release_key ? `release:${suggestion.release_key}` : null,
  ].filter(Boolean))];
}

/**
 * The ledger entry for one accepted host write, or null when it names no song. An album Moondog
 * started names its release instead, so every song of it that plays matches.
 */
export function suggestionEntry({ service, action, providerTrackId = null, isrc = null, title, release = null, artists, artistCredit, mixSlot = null, requestedAt }) {
  const credit = typeof artistCredit === "string" && artistCredit.trim() ? artistCredit.trim()
    : Array.isArray(artists) ? artists.filter((name) => typeof name === "string").join(", ") : "";
  const named = { title, release, artists, artist_credit: credit };
  const key = title ? songKeys(named)[0] ?? null : null;
  const album = !title && typeof release === "string" ? releaseKey(named) : null;
  if (!SUGGESTION_SERVICES.includes(service) || !(key || album)) return null;
  return {
    service, action,
    provider_track_id: typeof providerTrackId === "string" && providerTrackId ? providerTrackId : null,
    isrc: typeof isrc === "string" && /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/iu.test(isrc) ? isrc.toUpperCase() : null,
    track_key: key,
    release_key: album,
    title: Array.from(String(title || release).trim()).slice(0, 512).join(""),
    artist_credit: Array.from(credit).slice(0, 512).join(""),
    requested_at: requestedAt,
    mix_slot: key && MIX_SLOTS.includes(mixSlot) ? mixSlot : null,
  };
}

/**
 * Marks each stored play Moondog started with its suggestion, and returns the suggestions the
 * listener later played again on their own. Events are never rewritten.
 */
export function markMoondogStartedPlays(eventRows, suggestions) {
  const adopted = new Set();
  if (!suggestions.length) return { rows: eventRows, adopted };
  const byIdentity = new Map();
  for (const suggestion of suggestions) {
    const entry = { ...suggestion, requestedMs: Date.parse(suggestion.requested_at) };
    for (const identity of suggestionIdentities(suggestion)) {
      byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), entry]);
    }
  }
  const rows = eventRows.map((row) => {
    if (row.event?.extensions?.["spotify.incognito_mode"] === true) return row;
    const playedMs = Date.parse(row.event?.occurred_at);
    const matches = new Set(playedTrackIdentities(row.track).flatMap((identity) => byIdentity.get(identity) ?? []));
    if (!matches.size || !Number.isFinite(playedMs)) return row;
    const started = [...matches].find((entry) =>
      playedMs >= entry.requestedMs - SUGGESTION_WINDOW.beforeMs && playedMs <= entry.requestedMs + SUGGESTION_WINDOW.afterMs);
    if (started) return { ...row, moondog_suggestion_id: started.suggestion_id };
    for (const entry of matches) if (playedMs > entry.requestedMs + SUGGESTION_WINDOW.afterMs) adopted.add(entry.suggestion_id);
    return row;
  });
  return { rows, adopted };
}

// The declared mix: where each song sits in the listener's own plays, Moondog's plays left out.
// At least 3 plays is a song they know: familiar when one falls within 365 days of their latest
// play, otherwise returning (then none falls in the last 180 days either). One or two plays, or
// only plays Moondog started, is a song they have heard. With none, it is new from an artist
// they play, or new to them.
export const MIX_SLOTS = Object.freeze(["familiar", "returning", "heard", "known_artist", "new"]);

/** What the listener's own plays say about songs and artists, or null with no plays at all. */
export function listeningFamiliarity(catalog, referenceDate) {
  const referenceMs = Date.parse(referenceDate ?? "");
  if (!Number.isFinite(referenceMs) || !catalog?.history_tracks?.length) return null;
  const tracks = new Map();
  for (const row of catalog.history_tracks) {
    const key = trackMatchKey(row.label, row.artist_credit);
    if (!key) continue;
    const known = tracks.get(key) ?? { plays: 0, lastMs: 0 };
    known.plays += row.play_count ?? 0;
    known.lastMs = Math.max(known.lastMs, Date.parse(row.last_played_at) || 0);
    tracks.set(key, known);
  }
  const artists = new Set((catalog.history_artists ?? []).map((row) => normalizedArtistName(row.name)).filter(Boolean));
  const moondogHeard = new Set((catalog.moondog_suggestions ?? []).map((row) => trackMatchKey(row.label, row.artist_credit)).filter(Boolean));
  return { referenceMs, tracks, artists, moondogHeard };
}

export function mixSlot(track, familiarity) {
  if (!familiarity) return "unknown";
  const names = Array.isArray(track?.artists) && track.artists.length ? track.artists : creditNames(track?.artist_credit);
  let plays = 0;
  let lastMs = 0;
  let moondogHeard = false;
  for (const name of names) {
    const key = trackMatchKey(track?.title, name);
    moondogHeard ||= familiarity.moondogHeard?.has(key) === true;
    const known = familiarity.tracks.get(key);
    if (!known) continue;
    plays += known.plays;
    lastMs = Math.max(lastMs, known.lastMs);
  }
  if (plays >= 3) return familiarity.referenceMs - lastMs <= 365 * DAY_MS ? "familiar" : "returning";
  if (plays > 0 || moondogHeard) return "heard";
  return names.some((name) => familiarity.artists.has(normalizedArtistName(name))) ? "known_artist" : "new";
}

/** Counts per slot for a mix line, or null when no song could be placed. */
export function mixCounts(slots) {
  if (!slots.some((slot) => MIX_SLOTS.includes(slot))) return null;
  return Object.fromEntries(MIX_SLOTS.map((slot) => [slot, slots.filter((value) => value === slot).length]));
}
