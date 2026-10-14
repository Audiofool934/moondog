import { setTimeout as delay } from "node:timers/promises";

import { musicHash, musicText, prepareMusicBundle } from "../../profile/music-import-bundle.mjs";
import { readLastfmConfiguration } from "./settings.mjs";

// A listener's scrobbles (every play Last.fm counted) and loved tracks, read by username.
// Last.fm lists scrobbles newest first; the read stops at the moment it started, so new
// scrobbles can't shift the pages underneath it.
export const LASTFM_LIMITS = Object.freeze({
  maximumScrobbles: 500_000,
  maximumLovedTracks: 20_000,
  pageSize: 200,
  // Last.fm can suspend a key that keeps making several calls a second, so request starts
  // are paced across all readers. A full page can take Last.fm 2 to 17 seconds to answer;
  // three readers hide part of that wait, and more were not faster in practice.
  requestIntervalMs: 250,
  concurrency: 3,
  attempts: 5,
});

export class LastfmError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LastfmError";
    this.code = code;
  }
}

const fail = (message, code) => { throw new LastfmError(message, code); };

/** A Last.fm username, or the profile link it appears in (last.fm/user/<name>). */
export function lastfmUsername(input) {
  let value = String(input ?? "").trim();
  const link = value.match(/^(?:https?:\/\/)?(?:www\.)?last\.fm\/(?:[a-z]{2}\/)?user\/([^/?#\s]+)/iu);
  if (link) {
    try { value = decodeURIComponent(link[1]); } catch { value = ""; }
  }
  value = value.replace(/^@/u, "");
  if (!/^[^\s/\\?#\u0000-\u001f\u007f]{1,64}$/u.test(value)) {
    fail("Type your Last.fm username, as in your profile link: last.fm/user/<username>.", "lastfm_username_invalid");
  }
  return value;
}

const list = (value) => (Array.isArray(value) ? value : value && typeof value === "object" ? [value] : []);
// Last.fm writes names as plain strings, as {"#text"}, or as {"name"} depending on the method.
const name = (value) => musicText(typeof value === "string" ? value : value?.["#text"] ?? value?.name ?? "");
const fold = (value) => value.normalize("NFKC").toLocaleLowerCase("und");
// Last.fm identifies a track by its artist and title; the album changes from scrobble to scrobble.
const trackKey = (artist, title) => musicHash(JSON.stringify(["lastfm-track-v1", fold(artist), fold(title)]));
const retryable = new Set([8, 11, 16, 29]);
// The list each paged method must answer with.
const listFor = { "user.getrecenttracks": "recenttracks", "user.getlovedtracks": "lovedtracks" };

/** Spaces request starts at least `interval` apart, whichever reader asks. */
function requestPacer(interval, sleep, now, signal) {
  let next = 0;
  return async () => {
    const at = now();
    const wait = Math.max(0, next - at);
    next = Math.max(at, next) + interval;
    if (wait) await sleep(wait, undefined, { signal });
  };
}

async function lastfmCall({ root, apiKey, method, params, fetchImpl, signal, sleep, pace, attempts }) {
  const url = new URL(root);
  url.search = new URLSearchParams({ method, ...params, api_key: apiKey, format: "json" }).toString();
  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();
    await pace();
    const timeout = AbortSignal.timeout(20_000);
    let response;
    let body = null;
    try {
      response = await fetchImpl(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { "User-Agent": "Moondog (+https://github.com/Audiofool934/moondog)" },
      });
      body = await response.json().catch(() => null);
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt < attempts) { await sleep(500 * 2 ** attempt, undefined, { signal }); continue; }
      fail("Could not reach Last.fm. Check your connection and try again.", "lastfm_unreachable");
    }
    const code = Number(body?.error) || 0;
    const list = listFor[method];
    if (response.ok && body && !code && (!list || (body[list] && typeof body[list] === "object"))) return body;
    // Last.fm sometimes answers 200 with a page that isn't its JSON; that is retried like a busy answer,
    // so a broken first page can't pass for an empty history.
    const unreadable = response.ok && !code;
    if (unreadable || retryable.has(code) || response.status === 429 || response.status >= 500) {
      if (attempt < attempts) { await sleep((code === 29 || response.status === 429 ? 2_000 : 500) * 2 ** attempt, undefined, { signal }); continue; }
      if (code === 29 || response.status === 429) fail("Last.fm asked Moondog to slow down. Wait a minute, then try again.", "lastfm_rate_limited");
      fail("Last.fm is having trouble right now. Try again in a little while.", "lastfm_unavailable");
    }
    if (code === 6) fail("Last.fm doesn't know that username. Check it against your profile link.", "lastfm_user_not_found");
    if (code === 17) fail("This profile hides its recent listening. In Last.fm Settings > Privacy, turn off \"Hide recent listening information\", then try again.", "lastfm_user_private");
    if (code === 10 || code === 26) fail("Last.fm didn't accept the API key. Set up Last.fm access again.", "lastfm_key_invalid");
    fail(`Last.fm couldn't answer (${code ? `error ${code}` : `HTTP ${response.status}`}). Try again later.`, "lastfm_failed");
  }
}

/**
 * Pages 2..pages of a paged method, a few at a time; page 1 is already in hand.
 * The first page that fails stops the others, and the error waits until they have settled.
 */
async function remainingPages(pages, read, concurrency, stop) {
  let next = 2;
  let failure;
  const worker = async () => {
    while (next <= pages && !failure) {
      try {
        await read(next++);
      } catch (error) {
        failure ??= error;
        stop.abort(failure);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(0, Math.min(concurrency, pages - 1)) }, worker));
  if (failure) throw failure;
}

export async function readLastfmHistory({
  username,
  subjectId,
  capturedAt = new Date().toISOString(),
  configuration,
  environment = process.env,
  fetchImpl = fetch,
  signal,
  onProgress = () => {},
  sleep = delay,
  now = Date.now,
  limits = LASTFM_LIMITS,
} = {}) {
  const user = lastfmUsername(username);
  const access = configuration ?? await readLastfmConfiguration(environment);
  if (!access?.apiKey) fail("Moondog needs a Last.fm API key before it can read your history.", "lastfm_key_missing");
  // One read shares one pace and one stop, so a failed page also stops its siblings.
  const stop = new AbortController();
  const readSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const pace = requestPacer(limits.requestIntervalMs, sleep, now, readSignal);
  const call = (method, params) => lastfmCall({
    root: access.root, apiKey: access.apiKey, method, params: { user, ...params },
    fetchImpl, signal: readSignal, sleep, pace, attempts: limits.attempts,
  });
  const until = Math.floor(Date.parse(capturedAt) / 1_000);
  const pageSize = limits.pageSize;

  const scrobbles = [];
  const takeScrobbles = (body) => {
    for (const track of list(body?.recenttracks?.track)) {
      const at = Number(track?.date?.uts);
      // The track playing right now has no date and isn't a scrobble yet.
      if (track?.["@attr"]?.nowplaying === "true" || !Number.isSafeInteger(at) || at <= 0 || at > until) continue;
      const title = name(track.name);
      const artist = name(track.artist);
      if (title && artist) scrobbles.push({ at, title, artist, album: name(track.album) });
    }
  };
  const first = await call("user.getrecenttracks", { limit: pageSize, page: 1, to: until });
  const attributes = first?.recenttracks?.["@attr"] ?? {};
  const total = Number(attributes.total) || 0;
  const pages = Math.min(Number(attributes.totalPages) || 1, Math.ceil(limits.maximumScrobbles / pageSize));
  const expected = Math.min(total, limits.maximumScrobbles);
  takeScrobbles(first);
  onProgress({ stage: "scrobbles", count: scrobbles.length, total: expected });
  await remainingPages(pages, async (page) => {
    takeScrobbles(await call("user.getrecenttracks", { limit: pageSize, page, to: until }));
    onProgress({ stage: "scrobbles", count: scrobbles.length, total: expected });
  }, limits.concurrency, stop);

  const loved = [];
  const takeLoved = (body) => {
    for (const track of list(body?.lovedtracks?.track)) {
      const title = name(track?.name);
      const artist = name(track?.artist);
      if (title && artist) loved.push({ title, artist });
    }
  };
  const lovedFirst = await call("user.getlovedtracks", { limit: pageSize, page: 1 });
  const lovedPages = Math.min(Number(lovedFirst?.lovedtracks?.["@attr"]?.totalPages) || 1, Math.ceil(limits.maximumLovedTracks / pageSize));
  takeLoved(lovedFirst);
  onProgress({ stage: "loved", count: loved.length });
  await remainingPages(lovedPages, async (page) => {
    takeLoved(await call("user.getlovedtracks", { limit: pageSize, page }));
    onProgress({ stage: "loved", count: loved.length });
  }, limits.concurrency, stop);

  if (!scrobbles.length && !loved.length) {
    fail("This Last.fm profile has no scrobbles or loved tracks yet.", "lastfm_history_empty");
  }
  scrobbles.sort((left, right) => left.at - right.at || trackKey(left.artist, left.title).localeCompare(trackKey(right.artist, right.title)));
  const rows = [
    ...scrobbles.map((row) => ({
      id: trackKey(row.artist, row.title), title: row.title, artist: row.artist, album: row.album,
      occurredAt: new Date(row.at * 1_000).toISOString(), member: "lastfm-scrobbles.json",
    })),
    ...loved.map((row) => ({ id: trackKey(row.artist, row.title), title: row.title, artist: row.artist, member: "lastfm-loved-tracks.json" })),
  ];
  // The fingerprint covers exactly what was read, so the same history imports once.
  const bytes = Buffer.from(JSON.stringify({ user, until, scrobbles, loved }));
  const truncated = total > scrobbles.length && pages * pageSize >= limits.maximumScrobbles;
  const prepared = prepareMusicBundle({
    provider: "lastfm", subjectId, capturedAt, rows,
    digest: musicHash(bytes), size: bytes.length,
    members: ["lastfm-scrobbles.json", ...(loved.length ? ["lastfm-loved-tracks.json"] : [])],
    fileName: `last.fm/user/${user}`,
    scopeNote: truncated
      ? `Your latest ${limits.maximumScrobbles.toLocaleString("en-US")} scrobbles, the most Moondog reads at once, and your loved tracks.`
      : "Every scrobble Last.fm counted, and your loved tracks.",
  });
  prepared.preview.source = "lastfm";
  prepared.preview.lovedTracks = loved.length;
  prepared.preview.totalScrobbles = total;
  prepared.preview.truncated = truncated;
  prepared.preview.profileUrl = `https://www.last.fm/user/${encodeURIComponent(user)}`;
  return prepared;
}
