import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LastfmError, lastfmUsername, readLastfmHistory } from "../../src/integrations/lastfm/history.mjs";
import { readLastfmConfiguration, writeLastfmConfiguration } from "../../src/integrations/lastfm/settings.mjs";
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
  await assert.rejects(read(fakeLastfm({ history }), { configuration: null, environment: { MOONDOG_CONFIG_HOME: "/nonexistent-moondog-config" } }), { code: "lastfm_key_missing" });
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
  assert.equal(await readLastfmConfiguration(environment), undefined);
  await assert.rejects(writeLastfmConfiguration("not-a-key", environment), { code: "lastfm_settings_invalid" });
  await writeLastfmConfiguration(apiKey.toUpperCase(), environment);
  assert.deepEqual(await readLastfmConfiguration(environment), { apiKey, source: "settings", root: "https://ws.audioscrobbler.com/2.0/" });
  const fromEnvironment = await readLastfmConfiguration({ ...environment, MOONDOG_LASTFM_API_KEY: "a".repeat(32) });
  assert.equal(fromEnvironment.source, "environment");
  await assert.rejects(readLastfmConfiguration({ ...environment, MOONDOG_LASTFM_API_ROOT: "http://example.com/" }), { code: "lastfm_settings_invalid" });
});
