import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

import { LASTFM_LIMITS, LastfmError, lastfmUsername, readLastfmHistory } from "../../src/integrations/lastfm/history.mjs";
import { LASTFM_PROJECT_API_KEY, readLastfmConfiguration, writeLastfmConfiguration } from "../../src/integrations/lastfm/settings.mjs";
import { projectListenBrainzHistory } from "../../src/integrations/listenbrainz/history-file.mjs";
import { projectSpotifyExtendedStreamingHistory } from "../../src/integrations/spotify/extended-streaming-history.mjs";
import { musicHash } from "../../src/profile/music-import-bundle.mjs";
import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";

const subjectId = "4f1c8a52-7d3e-4b8a-9c11-2b6f0e5d7a90";
const apiKey = "0123456789abcdef0123456789abcdef";
const capturedAt = "2026-10-13T09:00:00.000Z";
const configuration = { apiKey, root: "https://ws.audioscrobbler.com/2.0/" };
const noWait = async () => {};

// Fictional scrobbles, one every hour going back from just before the capture.
function scrobbles(count, { start = Date.parse(capturedAt) / 1_000 - 60 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    uts: start - index * 3_600,
    artist: ["Mara Vale", "North Window", "Ash Meridian"][index % 3],
    name: `Song ${index % 7}`,
    album: index % 2 ? "Night Survey" : "",
  }));
}

/** A small stand-in for Last.fm's JSON API: newest first, paged, with a track playing now. */
function fakeLastfm({ history = [], loved = [], user = "rj", errors = [], single = false } = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const query = new URL(url).searchParams;
    requests.push(Object.fromEntries(query));
    options?.signal?.throwIfAborted();
    const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const error = errors.shift();
    if (error) return respond({ error, message: "Fixture error" }, error === 29 ? 429 : 400);
    if (query.get("api_key") !== apiKey) return respond({ error: 10, message: "Invalid API key" }, 403);
    if (query.get("user") !== user) return respond({ error: 6, message: "User not found" }, 404);
    const limit = Number(query.get("limit"));
    const page = Number(query.get("page"));
    if (query.get("method") === "user.getrecenttracks") {
      const until = Number(query.get("to"));
      const rows = history.filter((row) => row.uts <= until).sort((left, right) => right.uts - left.uts);
      const items = rows.slice((page - 1) * limit, page * limit).map((row) => ({
        artist: { mbid: "", "#text": row.artist }, name: row.name, album: { mbid: "", "#text": row.album },
        date: { uts: String(row.uts), "#text": "fixture" },
      }));
      if (page === 1) items.unshift({ artist: { "#text": "Playing Now" }, name: "Current Song", album: { "#text": "" }, "@attr": { nowplaying: "true" } });
      const track = single && items.length === 1 ? items[0] : items;
      return respond({ recenttracks: { track, "@attr": { user, page: String(page), perPage: String(limit), total: String(rows.length), totalPages: String(Math.max(1, Math.ceil(rows.length / limit))) } } });
    }
    if (query.get("method") === "user.getlovedtracks") {
      const items = loved.slice((page - 1) * limit, page * limit).map((row) => ({ name: row.name, artist: { name: row.artist, mbid: "" }, date: { uts: "1700000000" } }));
      return respond({ lovedtracks: { track: items, "@attr": { user, page: String(page), perPage: String(limit), total: String(loved.length), totalPages: String(Math.max(1, Math.ceil(loved.length / limit))) } } });
    }
    return respond({ error: 3, message: "Invalid method" }, 400);
  };
  return { fetchImpl, requests };
}

const read = (fake, options = {}) => readLastfmHistory({
  username: "rj", subjectId, capturedAt, configuration, fetchImpl: fake.fetchImpl, sleep: noWait, ...options,
});

test("Last.fm history reads every page of scrobbles and the loved tracks into one import", async () => {
  const fake = fakeLastfm({ history: scrobbles(450), loved: [{ artist: "Mara Vale", name: "Song 1" }, { artist: "Drift Assembly", name: "Northern Relay" }] });
  const progress = [];
  const prepared = await read(fake, { onProgress: (event) => progress.push(event) });

  assert.equal(prepared.provider, "lastfm");
  assert.equal(prepared.bundle.listening_events.length, 450, "the track playing now is not a scrobble");
  assert.equal(prepared.bundle.profile_evidence.length, 2);
  assert.equal(prepared.bundle.profile_evidence[0].provenance.source_system, "lastfm");
  assert.equal(prepared.preview.source, "lastfm");
  assert.equal(prepared.preview.lovedTracks, 2);
  assert.equal(prepared.preview.fileName, "last.fm/user/rj");
  assert.equal(prepared.preview.profileUrl, "https://www.last.fm/user/rj");
  assert.equal(prepared.preview.truncated, false);
  assert.equal(prepared.bundle.import_batch.earliest_occurred_at < prepared.bundle.import_batch.latest_occurred_at, true);
  // 21 artist and title pairs. Albums alternate on top of them, and a split by album would make 42.
  assert.equal(new Set(prepared.bundle.listening_events.map((event) => event.track_ref_id)).size, 21);

  const recent = fake.requests.filter((request) => request.method === "user.getrecenttracks");
  assert.deepEqual(recent.map((request) => request.page).sort(), ["1", "2", "3"]);
  assert.ok(recent.every((request) => request.limit === "200" && request.to === String(Date.parse(capturedAt) / 1_000)), "the read stops at the moment it started");
  assert.ok(fake.requests.every((request) => request.api_key === apiKey && request.format === "json"));
  assert.deepEqual(progress.at(-2), { stage: "scrobbles", count: 450, total: 450 });
  assert.deepEqual(progress.at(-1), { stage: "loved", count: 2 });
});

test("the same history imports once, and a later read adds only the new scrobbles", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-lastfm-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await openListeningHistoryStore({ databasePath: path.join(root, "listening-history.sqlite") });
  context.after(() => store.close());
  const history = scrobbles(30);

  const first = store.ingestImport((await read(fakeLastfm({ history }))).bundle);
  assert.equal(first.inserted_events, 30);
  const again = store.ingestImport((await read(fakeLastfm({ history }))).bundle);
  assert.equal(again.inserted_events, 0, "an identical read changes nothing");

  const later = "2026-10-14T09:00:00.000Z";
  const newer = [...scrobbles(5, { start: Date.parse(later) / 1_000 - 60 }), ...history];
  const update = store.ingestImport((await read(fakeLastfm({ history: newer }), { capturedAt: later })).bundle);
  assert.equal(update.inserted_events, 5);
  assert.equal(update.duplicate_events, 30);
});

test("a single scrobble arrives as an object instead of a list", async () => {
  const prepared = await read(fakeLastfm({ history: scrobbles(1), single: true }));
  assert.equal(prepared.bundle.listening_events.length, 1);
});

test("Last.fm errors become plain advice, and busy answers are retried", async () => {
  const history = scrobbles(3);
  await assert.rejects(read(fakeLastfm({ history }), { username: "someone-else" }), { code: "lastfm_user_not_found" });
  await assert.rejects(read(fakeLastfm({ history, errors: [17] })), (error) => error.code === "lastfm_user_private" && /Hide recent listening/u.test(error.message));
  await assert.rejects(read(fakeLastfm({ history }), { configuration: { ...configuration, apiKey: "f".repeat(32) } }), { code: "lastfm_key_invalid" });
  // With nothing set up, the read uses Moondog's own key; this stand-in only knows the test key.
  const unconfigured = fakeLastfm({ history });
  await assert.rejects(read(unconfigured, { configuration: null, environment: { MOONDOG_CONFIG_HOME: "/nonexistent-moondog-config" } }), { code: "lastfm_key_invalid" });
  assert.equal(unconfigured.requests[0].api_key, LASTFM_PROJECT_API_KEY);
  const busy = fakeLastfm({ history, errors: [29, 16] });
  assert.equal((await read(busy)).bundle.listening_events.length, 3);
  await assert.rejects(read(fakeLastfm({ history, errors: [29, 29, 29, 29, 29] })), { code: "lastfm_rate_limited" });
  await assert.rejects(read(fakeLastfm({})), { code: "lastfm_history_empty" });
});

test("stopping a read rejects at once without importing anything", async () => {
  const controller = new AbortController();
  const fake = fakeLastfm({ history: scrobbles(450) });
  const slow = async (url, options) => {
    if (new URL(url).searchParams.get("page") === "2") controller.abort();
    return fake.fetchImpl(url, options);
  };
  await assert.rejects(read(fake, { fetchImpl: slow, signal: controller.signal }), { name: "AbortError" });
});

test("a username or its profile link both work, and anything else is refused", () => {
  assert.equal(lastfmUsername(" rj "), "rj");
  assert.equal(lastfmUsername("https://www.last.fm/user/RJ"), "RJ");
  assert.equal(lastfmUsername("last.fm/zh/user/rj?tab=library"), "rj");
  assert.equal(lastfmUsername("@rj"), "rj");
  for (const input of ["", "two words", "a/b", "x".repeat(65)]) {
    assert.throws(() => lastfmUsername(input), LastfmError);
  }
});

test("the API key is saved on this machine and an environment key wins", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-lastfm-key-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const environment = { MOONDOG_CONFIG_HOME: root };
  assert.deepEqual(await readLastfmConfiguration(environment), { apiKey: LASTFM_PROJECT_API_KEY, source: "moondog", root: "https://ws.audioscrobbler.com/2.0/" });
  await assert.rejects(writeLastfmConfiguration("not-a-key", environment), { code: "lastfm_settings_invalid" });
  await writeLastfmConfiguration(apiKey.toUpperCase(), environment);
  assert.deepEqual(await readLastfmConfiguration(environment), { apiKey, source: "settings", root: "https://ws.audioscrobbler.com/2.0/" });
  const fromEnvironment = await readLastfmConfiguration({ ...environment, MOONDOG_LASTFM_API_KEY: "a".repeat(32) });
  assert.equal(fromEnvironment.source, "environment");
  await assert.rejects(readLastfmConfiguration({ ...environment, MOONDOG_LASTFM_API_ROOT: "http://example.com/" }), { code: "lastfm_settings_invalid" });
});

// Plays the listener also made on Spotify: when each started, how long it lasted, and what it was.
const at = (time) => Date.parse(`2026-10-01T${time}Z`) / 1_000;
const spotifyPlays = [
  { start: at("10:00:00"), seconds: 200, artist: "Mara Vale", title: "Song 1", uri: "1" },
  { start: at("11:00:00"), seconds: 180, artist: "North Window", title: "Song 2", uri: "2" },
  // Skipped after ten seconds, too short for Last.fm to scrobble.
  { start: at("12:00:00"), seconds: 10, artist: "Ash Meridian", title: "Song 3", uri: "3" },
];
// Last.fm's copies start within seconds of Spotify's; the last one was played somewhere else.
const scrobbled = [
  { uts: at("10:00:04"), artist: "Mara Vale", name: "Song 1", album: "" },
  { uts: at("11:00:00"), artist: "North Window", name: "Song 2", album: "" },
  { uts: at("13:00:00"), artist: "Drift Assembly", name: "Song 9", album: "" },
];

function spotifyHistory(plays) {
  const records = plays.map((play) => ({
    // Spotify records when a play ended.
    ts: new Date((play.start + play.seconds) * 1_000).toISOString().replace(".000Z", "Z"),
    ms_played: play.seconds * 1_000,
    master_metadata_track_name: play.title,
    master_metadata_album_artist_name: play.artist,
    master_metadata_album_album_name: "Fixture",
    spotify_track_uri: `spotify:track:${play.uri.padStart(22, "0")}`,
    reason_start: "clickrow", reason_end: "trackdone", shuffle: false, skipped: false, offline: false, incognito_mode: false,
  }));
  return projectSpotifyExtendedStreamingHistory({
    subjectId, records, archiveSha256: musicHash(JSON.stringify(records)), archiveSizeBytes: 4_096,
    memberNames: ["Streaming_History_Audio_2026.json"], capturedAt,
  });
}

async function storeFor(context) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-lastfm-mirrors-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = await openListeningHistoryStore({ databasePath: path.join(root, "listening-history.sqlite") });
  context.after(() => store.close());
  return store;
}

const counted = (store) => store.subjectDataStatus({ subjectId }).effective_listening_events;

test("a scrobble that repeats a Spotify play counts once, whichever was imported first", async (context) => {
  const lastfmLater = await storeFor(context);
  lastfmLater.ingestImport(spotifyHistory(spotifyPlays));
  const later = lastfmLater.ingestImport((await read(fakeLastfm({ history: scrobbled }))).bundle);
  assert.equal(later.inserted_events, 3, "every scrobble is kept");
  assert.equal(later.mirrored_events, 2);
  assert.equal(later.effective_event_delta, 1);
  assert.equal(counted(lastfmLater), 4, "three Spotify plays and the one scrobble from elsewhere");

  const lastfmFirst = await storeFor(context);
  lastfmFirst.ingestImport((await read(fakeLastfm({ history: scrobbled }))).bundle);
  const spotifyLater = lastfmFirst.ingestImport(spotifyHistory(spotifyPlays));
  assert.equal(spotifyLater.mirrored_events, 2);
  assert.equal(spotifyLater.effective_event_delta, 1);
  assert.equal(counted(lastfmFirst), 4);
  // Repeating an import links nothing new and changes no count.
  assert.equal(lastfmFirst.ingestImport(spotifyHistory(spotifyPlays)).mirrored_events, undefined);
  assert.equal(counted(lastfmFirst), 4);
});

test("a song played twice in a row pairs each scrobble with its own play", async (context) => {
  const store = await storeFor(context);
  store.ingestImport(spotifyHistory([
    { start: at("10:00:00"), seconds: 200, artist: "Mara Vale", title: "Song 1", uri: "1" },
    { start: at("10:03:20"), seconds: 200, artist: "Mara Vale", title: "Song 1", uri: "1" },
  ]));
  const receipt = store.ingestImport((await read(fakeLastfm({ history: [
    { uts: at("10:00:01"), artist: "mara vale", name: "Song 1", album: "" },
    { uts: at("10:03:21"), artist: "Mara Vale", name: "song 1", album: "" },
  ] }))).bundle);
  assert.equal(receipt.mirrored_events, 2);
  assert.equal(counted(store), 2);
});

test("a ListenBrainz listen and its Last.fm copy count once, and different songs never match", async (context) => {
  const store = await storeFor(context);
  const listens = [
    { listened_at: at("10:00:00"), track_metadata: { artist_name: "Mara Vale", track_name: "Song 1" } },
    { listened_at: at("11:00:00"), track_metadata: { artist_name: "North Window", track_name: "Other Song" } },
  ];
  store.ingestImport(projectListenBrainzHistory({
    subjectId, document: { payload: { count: listens.length, listens, user_id: "rj" } },
    fileSha256: "a".repeat(64), fileSizeBytes: 512, memberName: "listens.json", capturedAt,
  }));
  const receipt = store.ingestImport((await read(fakeLastfm({ history: [
    { uts: at("10:00:00"), artist: "Mara Vale", name: "Song 1", album: "" },
    { uts: at("11:00:00"), artist: "North Window", name: "Song 2", album: "" },
  ] }))).bundle);
  assert.equal(receipt.mirrored_events, 1);
  assert.equal(counted(store), 3);
});

test("requests are paced across readers, however fast Last.fm answers", async () => {
  // A shorter interval than the real 250 ms keeps the test quick; the pacing is the same.
  const interval = 40;
  const starts = [];
  const fake = fakeLastfm({ history: scrobbles(1_000) });
  const fetchImpl = (url, options) => { starts.push(performance.now()); return fake.fetchImpl(url, options); };
  await read(fake, { fetchImpl, sleep: setTimeout, limits: { ...LASTFM_LIMITS, requestIntervalMs: interval } });
  assert.equal(starts.length, 6, "five pages of scrobbles and one of loved tracks");
  // Event-loop delays can shift one start, but the k-th request never starts before k intervals have passed.
  for (let index = 1; index < starts.length; index += 1) {
    const elapsed = starts[index] - starts[0];
    assert.ok(elapsed >= index * interval - 3, `request ${index + 1} started ${elapsed.toFixed(1)} ms after the first`);
  }
});

test("a page that fails for good stops the other readers instead of reading on", async () => {
  const fake = fakeLastfm({ history: scrobbles(4_000) });
  const fetchImpl = (url, options) => new URL(url).searchParams.get("page") === "3"
    ? Promise.resolve(new Response(JSON.stringify({ error: 7, message: "Invalid resource" }), { status: 400 }))
    : fake.fetchImpl(url, options);
  await assert.rejects(read(fake, { fetchImpl }), { code: "lastfm_failed" });
  const pages = fake.requests.filter((request) => request.method === "user.getrecenttracks").length;
  // Page 1, then at most one page per reader already under way when page 3 failed.
  assert.ok(pages <= 1 + LASTFM_LIMITS.concurrency, `read ${pages} of 20 pages after page 3 failed`);
  assert.ok(!fake.requests.some((request) => request.method === "user.getlovedtracks"));
});

test("a 200 answer that isn't Last.fm's list is read again, never taken for an empty history", async () => {
  const fake = fakeLastfm({ history: scrobbles(3) });
  let broken = 1;
  const flaky = (url, options) => broken-- > 0
    ? Promise.resolve(new Response("<html>busy</html>", { status: 200, headers: { "content-type": "text/html" } }))
    : fake.fetchImpl(url, options);
  assert.equal((await read(fake, { fetchImpl: flaky })).bundle.listening_events.length, 3);
  const listless = () => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  await assert.rejects(read(fake, { fetchImpl: listless }), { code: "lastfm_unavailable" });
});
