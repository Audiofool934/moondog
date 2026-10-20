import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

import { createListeningProfileDomainServices } from "../../src/core/listening-profile-domain-services.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { LASTFM_LIMITS, LastfmError, lastfmUsername, readLastfmHistory } from "../../src/integrations/lastfm/history.mjs";
import { LASTFM_PROJECT_API_KEY, readLastfmConfiguration, writeLastfmConfiguration } from "../../src/integrations/lastfm/settings.mjs";
import { projectListenBrainzHistory } from "../../src/integrations/listenbrainz/history-file.mjs";
import { projectSpotifyExtendedStreamingHistory } from "../../src/integrations/spotify/extended-streaming-history.mjs";
import { musicHash } from "../../src/profile/music-import-bundle.mjs";
import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";
import { createListeningHistoryProfileProjection } from "../../src/profile/spotify-archive-taste.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";
import { createTasteprintView } from "../../src/surfaces/html/tasteprint.mjs";

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
    reason_start: "clickrow", reason_end: "trackdone", shuffle: false,
    skipped: play.skipped === undefined ? false : play.skipped, offline: false, incognito_mode: false,
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

test("an explanation states only the listening time and skips that were recorded", async (context) => {
  const store = await storeFor(context);
  // Spotify's extended history records both measures, but leaves some skips null.
  store.ingestImport(spotifyHistory([
    { start: at("10:00:00"), seconds: 200, artist: "Mara Vale", title: "Song 1", uri: "1" },
    { start: at("11:00:00"), seconds: 180, artist: "Mara Vale", title: "Song 1", uri: "1", skipped: null },
    { start: at("12:00:00"), seconds: 240, artist: "North Window", title: "Song 2", uri: "2" },
  ]));
  // Last.fm records neither, for an artist Spotify also played and for one only Last.fm saw.
  store.ingestImport((await read(fakeLastfm({ history: [
    { uts: at("14:00:00"), artist: "Mara Vale", name: "Song 4", album: "" },
    { uts: at("15:00:00"), artist: "Drift Assembly", name: "Song 9", album: "" },
    { uts: at("16:00:00"), artist: "Drift Assembly", name: "Song 9", album: "" },
  ] }))).bundle);
  const behavior = store.profileSummary({ subjectId, maxItems: 50 }).listening_behavior;
  const basis = (rows, name) => store.explainProfileEvidence({ subjectId, evidenceId: rows.find((row) =>
    (row.name ?? `${row.label} - ${row.artist_credit}`) === name).evidence_id }).basis_summary;

  assert.equal(basis(behavior.enduring_artists, "Drift Assembly"), "2 plays across 1 track, from 2026-10-01 to 2026-10-01.");
  assert.equal(basis(behavior.repeat_tracks, "Song 9 - Drift Assembly"), "2 plays, from 2026-10-01 to 2026-10-01.");
  assert.equal(basis(behavior.enduring_artists, "Mara Vale"),
    "3 plays across 2 tracks, 6 minutes across the 2 timed plays, from 2026-10-01 to 2026-10-01.");
  assert.equal(basis(behavior.repeat_tracks, "Song 1 - Mara Vale"),
    "2 plays, 6 minutes in all, from 2026-10-01 to 2026-10-01. Never skipped in the 1 play with skip data.");
  // With both measures recorded for every play, the explanation reads as it always has.
  assert.equal(basis(behavior.repeat_tracks, "Song 2 - North Window"),
    "1 play, 4 minutes in all, from 2026-10-01 to 2026-10-01. Never skipped.");
});

test("songs to hear again come from plays alone when no play records its length", async (context) => {
  const store = await storeFor(context);
  const plays = (artist, name, dates) => dates.map((date) => ({ uts: Date.parse(`${date}T12:00:00Z`) / 1_000, artist, name, album: "" }));
  store.ingestImport((await read(fakeLastfm({ history: [
    ...plays("Mara Vale", "Old Signal", ["2019-02-01", "2019-03-01", "2019-04-01", "2019-05-01"]),
    ...plays("North Window", "Second Wind", ["2020-01-10", "2020-02-10", "2020-03-10", "2022-06-01", "2022-07-01", "2022-08-01"]),
    ...plays("Drift Assembly", "Northern Relay", ["2024-01-05", "2024-02-05", "2024-03-05", "2026-09-30"]),
  ] }))).bundle);
  const behavior = store.profileSummary({ subjectId, maxItems: 10 }).listening_behavior;
  const picks = [...behavior.rediscovery_tracks, ...behavior.historical_return_tracks, ...behavior.time_capsule_tracks];
  const basis = (row) => store.explainProfileEvidence({ subjectId, evidenceId: row.evidence_id }).basis_summary;

  assert.deepEqual(behavior.rediscovery_tracks.map((row) => row.label), ["Second Wind", "Old Signal"]);
  assert.deepEqual(behavior.historical_return_tracks.map((row) => row.label), ["Northern Relay", "Second Wind"]);
  assert.deepEqual(behavior.time_capsule_tracks.map((row) => [row.capsule_year, row.label]),
    [[2019, "Old Signal"], [2020, "Second Wind"], [2024, "Northern Relay"]]);
  assert.equal(basis(behavior.time_capsule_tracks[0]),
    "2019 is this song's biggest year in your history: 4 plays. Songs you asked me to keep out are never picked.");
  // Last.fm records neither length nor skips, so no pick states them, as zero or otherwise.
  for (const row of picks) {
    assert.deepEqual(Object.keys(row).filter((key) => /minutes|skips/u.test(key)), [], row.label);
    assert.doesNotMatch(basis(row), /minute|skip/u);
  }

  // The chat agent's tools take the same picks.
  const application = new MoondogApplication({ importsRoot: path.join(tmpdir(), "moondog-missing-imports"),
    domainServices: createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId }) });
  context.after(() => application.close());
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({ application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  const tools = ["moondog_rediscovery_candidates", "moondog_historical_return_candidates", "moondog_time_capsule_candidates"];
  const results = new Map();
  faux.setResponses([
    fauxAssistantMessage(tools.map((tool) => fauxToolCall(tool, {})), { stopReason: "toolUse" }),
    (conversation) => {
      for (const message of conversation.messages.filter((item) => item.role === "toolResult")) {
        const text = message.content[0].text;
        results.set(message.toolName, text.startsWith("{") ? JSON.parse(text) : { error: text });
      }
      return fauxAssistantMessage([fauxText("Fictional reply.")]);
    },
  ]);
  await runtime.prompt("Find songs I could hear again.");
  for (const tool of tools) {
    assert.equal(results.get(tool)?.state, "ready", results.get(tool)?.error ?? tool);
    assert.doesNotMatch(JSON.stringify(results.get(tool).tracks), /minutes"|skips"/u, tool);
  }
});

test("a history with no lengths or skips never reads as zero minutes, zero skips or unplayed", async (context) => {
  const store = await storeFor(context);
  // Fictional scrobbles of three whole albums: one that came back, one that went quiet, one recent.
  const album = (artist, title, dates) => dates.flatMap((date) => [1, 2, 3].map((track) => ({
    uts: Date.parse(`${date}T20:0${track}:00Z`) / 1_000, artist, name: `${title} ${track}`, album: title })));
  store.ingestImport((await read(fakeLastfm({ history: [
    ...album("Mara Vale", "Night Survey", ["2022-02-01", "2022-05-01", "2023-03-01", "2026-09-20"]),
    ...album("North Window", "Glass Weather", ["2023-01-10", "2023-02-10", "2023-03-10", "2024-06-01"]),
    ...album("Drift Assembly", "Northern Relay", ["2024-01-05", "2024-02-05", "2026-09-30"]),
  ] }))).bundle);
  const domainServices = createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId });
  const application = new MoondogApplication({ importsRoot: path.join(tmpdir(), "moondog-missing-imports"), domainServices });
  context.after(() => application.close());

  const summary = store.profileSummary({ subjectId, maxItems: 10 });
  const behavior = summary.listening_behavior;
  for (const section of ["rediscovery_tracks", "historical_return_tracks", "time_capsule_tracks", "release_depth", "artist_relationships"]) {
    assert.ok(behavior[section].length > 0, `${section} has rows to check`);
  }
  const input = domainServices.getProfileBuildContext().input;
  const evidenceIds = [...new Set(JSON.stringify(summary).match(/"evidence_id":"[0-9a-f-]{36}"/gu).map((match) => match.slice(15, -1)))];
  const bases = evidenceIds.map((evidenceId) => store.explainProfileEvidence({ subjectId, evidenceId }).basis_summary);

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({ application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  let tool;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("moondog_profile_summary", { max_items: 10 })], { stopReason: "toolUse" }),
    (conversation) => {
      tool = JSON.parse(conversation.messages.find((message) => message.role === "toolResult").content[0].text);
      return fauxAssistantMessage([fauxText("Fictional reply.")]);
    },
  ]);
  await runtime.prompt("What do you know about my listening?");
  assert.equal(tool.listening_behavior.enduring_artists.length, 3);
  // The Tasteprint page keeps its seasons without minutes or skips.
  const tasteprint = createTasteprintView(createListeningHistoryProfileProjection(summary), { generatedAt: capturedAt });
  assert.ok(tasteprint.behavior.listening_seasons?.seasons.length > 0);

  // A measure field, not a pick threshold such as rediscovery_minimum_listening_minutes.
  const measures = (value, at = "") => Array.isArray(value) ? value.flatMap((item, index) => measures(item, `${at}[${index}]`))
    : value && typeof value === "object" ? Object.entries(value).flatMap(([key, item]) => [
      ...(/minutes|skips|hours/u.test(key) && !/minimum|maximum|gap/u.test(key) ? [`${at}.${key}`] : []),
      ...measures(item, `${at}.${key}`)])
    : [];
  // Only the paused Studio and Tasteprint pages read the monthly pulse.
  const { monthly_activity: _monthlyActivity, ...listening } = behavior;
  const checked = {
    summary: { ...summary, listening_behavior: listening },
    tool,
    input: [input.manifest, ...[...input.evidence.values()].map((entry) => entry.data)],
  };
  for (const [name, value] of Object.entries(checked)) {
    assert.deepEqual(measures(value), [], `${name} states only what the plays recorded`);
    assert.doesNotMatch(JSON.stringify(value), /\b0 minutes|never skipped|unplayed/iu, name);
  }
  for (const basis of bases) assert.doesNotMatch(basis, /minute|skip|unplayed/iu);
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
