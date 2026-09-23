import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openLyricLibrary, parseLyricLines, homeLyricLines } from "../../src/core/lyric-library.mjs";
import { lyricSeedsFromProfile } from "../../src/core/lyric-profile.mjs";
import { createLyricService } from "../../src/core/lyric-service.mjs";
import { createLrclibProvider } from "../../src/integrations/lyrics/lrclib.mjs";

// Original fixture text, not lyrics copied from a music catalog.
const track = { title: "Fixture Song", artist: "Fixture Artist", weight: 3 };
const record = {
  state: "ready", provider: "lrclib", providerId: "42", sourceUrl: "https://lrclib.net/api/get/42",
  title: track.title, artist: track.artist, album: "Fixture Album", durationSeconds: 120,
  plainLyrics: "The test room has a blue ceiling\nThe second fixture has a yellow door",
  syncedLyrics: "[00:01.50]The test room has a blue ceiling\n[00:04.25]The second fixture has a yellow door",
};

test("lyric library preserves source text, timing, metadata and recent selections across reopening", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "moondog-lyrics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "lyrics.sqlite");
  let library = await openLyricLibrary({ databasePath });
  library.put(track, record, 1234);
  const saved = library.get(track);
  assert.equal(saved.plainLyrics, record.plainLyrics);
  assert.equal(saved.syncedLyrics, record.syncedLyrics);
  assert.equal(saved.providerId, "42");
  assert.equal(saved.lines[1].startMs, 4250);
  const first = library.selectHome({ tracks: [track], subjectId: "one", random: () => 0 });
  library.close();
  library = await openLyricLibrary({ databasePath });
  try {
    const second = library.selectHome({ tracks: [track], subjectId: "one", random: () => 0 });
    assert.notEqual(second.text, first.text);
    const separate = library.selectHome({ tracks: [track], subjectId: "two", random: () => 0 });
    assert.equal(separate.text, first.text);
    assert.equal(library.selectHome({ tracks: [], subjectId: "one" }), null);
    assert.equal(library.status().ready, 1);
    if (process.platform !== "win32") assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  } finally { library.close(); }
});

test("timed lyric parsing supports repeated timestamps and excludes credits from home text", () => {
  const lines = parseLyricLines({ syncedLyrics: "[ti:Fixture]\n[00:03.4][00:09.025]这是测试文本，保留原来的语言\n[01:05]作词：测试作者" });
  assert.deepEqual(lines.map((line) => line.startMs), [3400, 9025, 65000]);
  assert.deepEqual(homeLyricLines(lines), ["这是测试文本，保留原来的语言"]);
  assert.deepEqual(homeLyricLines(parseLyricLines({ plainLyrics: "[Chorus]\nWritten by Fixture\nhttps://example.com\n" + "x".repeat(81) })), []);
  assert.deepEqual(parseLyricLines({ syncedLyrics: "[offset:+250]\n[00:01.00]Fixture [echo] text\n[00:02.00]" }), [
    { text: "Fixture [echo] text", startMs: 750 }, { text: "", startMs: 1750 },
  ]);
});

test("profile seed selection prioritizes likes, does not mistake albums for songs, and applies every exclusion", () => {
  const item = (label, artist_credit = "A") => ({ label, artist_credit, entity_type: "track" });
  const profile = {
    listener_assertions: { preferences: [item("Loved"), item("Blocked song"), item("Other", "Blocked artist")] },
    strong_preferences: [item("Imported favorite"), { ...item("An album"), entity_type: "album" }],
    curated_preferences: { saved_tracks: [item("Saved"), item("Loved")] },
    listening_behavior: { repeat_tracks: [{ ...item("Repeated"), play_count: 8 }, { ...item("Only once"), play_count: 1 }] },
    lyric_exclusions: [{ entity_type: "artist", label: "Blocked artist" }, item("Blocked song")],
  };
  const seeds = lyricSeedsFromProfile(profile);
  assert.deepEqual(seeds.map((seed) => seed.title), ["Loved", "Imported favorite", "Saved", "Repeated"]);
  assert.equal(seeds[0].basis, "explicit_like");
  assert.equal(seeds.at(-1).basis, "repeated_listening");
  assert.ok(seeds[0].weight > seeds.at(-1).weight);
});

test("provider uses an identified exact-signature request and rejects wrong versions", async () => {
  let request;
  const payload = { id: 42, trackName: track.title, artistName: track.artist, albumName: "Fixture Album", duration: 120, plainLyrics: record.plainLyrics };
  const provider = createLrclibProvider({ fetchImpl: async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify(payload));
  } });
  const result = await provider.lookup({ ...track, album: "Fixture Album", durationSeconds: 120 });
  assert.equal(result.state, "ready");
  assert.match(request.options.headers["User-Agent"], /Moondog/);
  assert.equal(request.url.searchParams.get("track_name"), track.title);
  assert.equal(request.url.searchParams.has("profile"), false);
  assert.equal(request.options.redirect, "error");
  assert.equal((await provider.lookup({ ...track, artist: "Another Artist" })).state, "mismatch");
  assert.equal((await provider.lookup({ ...track, durationSeconds: 150 })).state, "mismatch");
});

test("provider handles instrumentals, missing tracks and retry-after without inventing text", async () => {
  const missing = createLrclibProvider({ fetchImpl: async () => new Response("", { status: 404 }) });
  assert.equal((await missing.lookup(track)).state, "not_found");
  const instrumental = createLrclibProvider({ fetchImpl: async () => new Response(JSON.stringify({ id: 1, trackName: track.title, artistName: track.artist, instrumental: true })) });
  assert.equal((await instrumental.lookup(track)).state, "instrumental");
  const limited = createLrclibProvider({ fetchImpl: async () => new Response("", { status: 429, headers: { "Retry-After": "120" } }) });
  await assert.rejects(limited.lookup(track), (error) => error.retryAfterMs === 120_000);
});

test("background sync caches positive and negative matches, rate limits across sessions, and works offline", async () => {
  const library = await openLyricLibrary({ databasePath: ":memory:" });
  let requests = 0;
  const seeds = { subjectId: "one", tracks: [track, { title: "Missing", artist: "A" }] };
  const service = await createLyricService({ library, throttleMs: 0, now: () => 10_000,
    provider: { async lookup(candidate) { requests++; return candidate.title === track.title ? record : { state: "not_found" }; } },
  });
  try {
    await service.refresh(seeds);
    assert.equal(requests, 2);
    await service.refresh(seeds);
    assert.equal(requests, 2);
    assert.ok(service.selectHome(seeds));
    const offline = await createLyricService({ library, environment: { MOONDOG_LYRICS: "off" }, provider: { lookup() { throw new Error("must not fetch"); } } });
    assert.equal((await offline.refresh(seeds)).state, "offline");
    assert.ok(offline.selectHome(seeds));
    const limited = await createLyricService({ library, throttleMs: 0, now: () => 20_000,
      provider: { async lookup() { const error = new Error("limited"); error.retryAfterMs = 90_000; throw error; } },
    });
    const fresh = { tracks: [{ title: "Uncached", artist: "A" }] };
    assert.equal((await limited.refresh(fresh)).state, "unavailable");
    assert.equal(library.retryAt(), 110_000);
    assert.equal((await limited.refresh(fresh)).state, "deferred");
  } finally { library.close(); }
});

test("cancelled enrichment stops before writing or requesting another song", async () => {
  const library = await openLyricLibrary({ databasePath: ":memory:" });
  const controller = new AbortController();
  let calls = 0;
  const service = await createLyricService({ library, throttleMs: 0, provider: {
    async lookup() { calls++; controller.abort(); return record; },
  } });
  try {
    const result = await service.refresh({ tracks: [track, { ...track, title: "Another" }] }, { signal: controller.signal });
    assert.equal(result.state, "cancelled");
    assert.equal(calls, 1);
    assert.equal(library.status().entries, 0);
  } finally { library.close(); }
});
