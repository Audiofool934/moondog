import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AppleProjectionDomainServices, exactTitleArtistMatch } from "../../src/core/apple-projection-domain-services.mjs";
import { createListeningProfileDomainServices } from "../../src/core/listening-profile-domain-services.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { normalizedTrackTitle, textNamesTitle } from "../../src/core/track-title.mjs";
import { projectSpotifyRecentActivity } from "../../src/integrations/spotify/recent-activity.mjs";
import { listenerProfileDossier, createListenerProfileInput } from "../../src/profile/listener-profile-build.mjs";
import {
  openEphemeralListeningHistoryStore,
  openListeningHistoryStore,
} from "../../src/profile/listening-history-store.mjs";
import { markMoondogStartedPlays, songKeys } from "../../src/profile/moondog-suggestions.mjs";

const subjectId = "22222222-2222-4222-8222-222222222222";

// Fictional plays as the 30-minute recent-play sync reads them.
function syncPlays(store, plays, album = "Fictional Record") {
  const latest = plays.map(([, , , playedAt]) => playedAt).sort().at(-1);
  return store.ingest(projectSpotifyRecentActivity({
    subjectId,
    capturedAt: new Date(Date.parse(latest) + 60_000).toISOString(),
    page: {
      provider: "spotify",
      items: plays.map(([id, name, artist, playedAt]) => ({
        played_at: playedAt,
        track: { id, name, artists: [artist], album, duration_ms: 200_000 },
        context_type: "album",
      })),
    },
  }));
}

const queued = (title, artist, id, requestedAt, extra = {}) => ({
  service: "spotify", action: "queue.batch", providerTrackId: `spotify:track:${id}`,
  title, artists: [artist], requestedAt, ...extra,
});

test("a version suffix names the same song for knownness", () => {
  for (const title of ["Glass Harbor - 2011 Remaster", "Glass Harbor (Remastered 2009)", "Glass Harbor - Live",
    "Glass Harbor (feat. Mira Vale)", "Glass Harbor [Deluxe]", "Glass Harbor (Live) - 2015 Remaster"]) {
    assert.equal(normalizedTrackTitle(title), "glass harbor", title);
  }
  assert.equal(normalizedTrackTitle("Glass Harbor - Remix"), "glass harbor - remix");
  assert.equal(normalizedTrackTitle("Live"), "live");
  assert.equal(exactTitleArtistMatch(
    { title: "Glass Harbor - 2011 Remaster", artist_credit: "The Lanterns" },
    { title: "Glass Harbor", artist_credit: "The Lanterns" },
  ), true);
});

test("a queued song that comes back through the recent-play sync is Moondog's, and a later own play counts and adopts it", async () => {
  const store = await openEphemeralListeningHistoryStore();
  try {
    syncPlays(store, [
      ["own1", "Glass Harbor", "The Lanterns", "2026-08-01T10:00:00.000Z"],
      ["own1", "Glass Harbor", "The Lanterns", "2026-08-02T10:00:00.000Z"],
    ]);
    const before = store.profileEvidenceRevision({ subjectId });
    store.recordMoondogSuggestions({ entries: [queued("Paper Comet", "The Lanterns", "mdq1", "2026-08-10T10:00:00.000Z")] });
    // Nothing played after the suggestion yet, so the reading stays current.
    assert.equal(store.profileEvidenceRevision({ subjectId }), before);

    syncPlays(store, [["mdq1", "Paper Comet", "The Lanterns", "2026-08-10T10:20:00.000Z"]]);
    let catalog = store.profileCatalog({ subjectId });
    assert.equal(catalog.sections.history_tracks.some((row) => row.label === "Paper Comet"), false);
    assert.deepEqual(catalog.sections.history_artists.map((row) => [row.name, row.play_count]), [["The Lanterns", 2]]);
    assert.equal(catalog.context.moondog_started_events_excluded, 1);
    assert.deepEqual(catalog.sections.moondog_suggestions.map(({ label, play_count: plays, adopted }) => ({ label, plays, adopted })),
      [{ label: "Paper Comet", plays: 1, adopted: false }]);
    const attention = store.recentAttention({ subjectId, now: Date.parse("2026-08-10T12:00:00.000Z") });
    assert.equal(attention.plays, 2);
    assert.equal(attention.moondog_started_plays, 1);
    assert.deepEqual(store.moondogSuggestionHistory({ subjectId, tracks: [{ title: "Paper Comet - 2011 Remaster", artists: ["The Lanterns"] }] }),
      [{ times: 1, last_suggested_at: "2026-08-10", adopted: false }]);
    const matched = store.profileEvidenceRevision({ subjectId });

    // Two days later the listener plays it again on their own.
    syncPlays(store, [["mdq1", "Paper Comet", "The Lanterns", "2026-08-12T09:00:00.000Z"]]);
    catalog = store.profileCatalog({ subjectId });
    assert.equal(catalog.sections.history_tracks.find((row) => row.label === "Paper Comet")?.play_count, 1);
    assert.equal(catalog.sections.moondog_suggestions[0].adopted, true);
    assert.deepEqual(store.moondogSuggestionHistory({ subjectId, tracks: [{ providerTrackId: "spotify:track:mdq1", title: "Paper Comet", artists: ["The Lanterns"] }] }),
      [{ times: 1, last_suggested_at: "2026-08-10", adopted: true }]);
    assert.notEqual(store.profileEvidenceRevision({ subjectId }), matched);

    // The reading's builder sees Moondog's plays apart from the rankings.
    const dossier = listenerProfileDossier(createListenerProfileInput({ subjectId, evidenceRevision: "test", listening: catalog }));
    assert.equal(dossier.played_from_moondog.plays, 1);
    assert.equal(dossier.played_from_moondog.adopted_tracks, 1);
    assert.equal(dossier.played_from_moondog.examples[0].label, "Paper Comet");
    assert.equal(dossier.played_from_moondog.examples[0].adopted, true);
  } finally {
    store.close();
  }
});

test("the mix places songs by the listener's own plays, remasters included", async () => {
  const store = await openEphemeralListeningHistoryStore();
  try {
    assert.deepEqual(store.listeningMix({ subjectId, tracks: [{ title: "Anything", artists: ["Anyone"] }] }), ["unknown"]);
    syncPlays(store, [
      ...["2026-07-01", "2026-07-02", "2026-07-03"].map((day) => ["t1", "Glass Harbor", "The Lanterns", `${day}T10:00:00.000Z`]),
      ...["2024-03-01", "2024-03-02", "2024-03-03"].map((day) => ["t2", "Old Lighthouse", "Mira Vale", `${day}T10:00:00.000Z`]),
      ["t3", "Salt Road", "The Lanterns", "2026-07-04T10:00:00.000Z"],
    ]);
    // A song Moondog played does not make it familiar, but the listener has heard it.
    store.recordMoondogSuggestions({ entries: [queued("Night Ferry", "Mira Vale", "t4", "2026-07-05T09:00:00.000Z")] });
    syncPlays(store, ["10:00", "10:05", "10:10"].map((time) => ["t4", "Night Ferry", "Mira Vale", `2026-07-05T${time}:00.000Z`]));
    assert.deepEqual(store.listeningMix({ subjectId, tracks: [
      { title: "Glass Harbor - 2011 Remaster", artists: ["The Lanterns"] },
      { title: "Old Lighthouse", artist_credit: "Mira Vale, Guest" },
      { title: "Salt Road (Live)", artists: ["The Lanterns"] },
      { title: "Night Ferry", artists: ["Mira Vale"] },
      { title: "Unwritten", artists: ["Nobody Known"] },
      { title: "Lantern Song", artists: ["Mira Vale"] },
    ] }), ["familiar", "returning", "heard", "heard", "new", "known_artist"]);
  } finally {
    store.close();
  }
});

test("an older history database opens and gains the ledger without a schema bump", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "moondog-ledger-"));
  const databasePath = path.join(directory, "listening-history.sqlite");
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const first = await openListeningHistoryStore({ databasePath });
    syncPlays(first, [["own1", "Glass Harbor", "The Lanterns", "2026-08-01T10:00:00.000Z"]]);
    first.close();
    // The previous schema had no ledger table.
    const raw = new DatabaseSync(databasePath);
    raw.exec("DROP TABLE moondog_suggestions");
    assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 7);
    raw.close();
    const reopened = await openListeningHistoryStore({ databasePath });
    try {
      assert.deepEqual(reopened.recordMoondogSuggestions({ entries: [queued("Paper Comet", "The Lanterns", "x1", "2026-08-02T10:00:00.000Z")] }), { recorded: 1 });
      assert.equal(reopened.profileCatalog({ subjectId }).sections.history_tracks.length, 1);
    } finally {
      reopened.close();
    }
    const check = new DatabaseSync(databasePath);
    assert.equal(check.prepare("PRAGMA user_version").get().user_version, 7);
    check.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an artist whose name holds a separator is one artist for the mix and the ledger", async () => {
  const store = await openEphemeralListeningHistoryStore();
  try {
    const artists = [["Thunder Road", "AC/DC"], ["The Narrow Boat", "Simon & Garfunkel"], ["Late September", "Earth, Wind & Fire"],
      ["See You Soon", "Tyler, The Creator"]];
    syncPlays(store, artists.flatMap(([title, artist], index) => ["01", "02", "03", "04"]
      .map((day) => [`sep${index}`, title, artist, `2026-07-${day}T1${index}:00:00.000Z`])));
    // A plan names its artists only as one credit.
    assert.deepEqual(store.listeningMix({ subjectId, tracks: artists.map(([title, artist]) => ({ title, artist_credit: artist })) }),
      ["familiar", "familiar", "familiar", "familiar"]);
    assert.deepEqual(store.listeningMix({ subjectId, tracks: [{ title: "Thunder Road", artist_credit: "AC/DC, Guest Singer" }] }), ["familiar"]);
    // A credit-only suggestion still matches its plays by song.
    store.recordMoondogSuggestions({ entries: [{ service: "spotify", action: "playlist.write", title: "Thunder Road",
      artistCredit: "AC/DC", requestedAt: "2026-07-10T10:00:00.000Z" }] });
    syncPlays(store, [["sepOther", "Thunder Road - 2003 Remaster", "AC/DC", "2026-07-10T10:30:00.000Z"]]);
    const catalog = store.profileCatalog({ subjectId });
    assert.equal(catalog.context.moondog_started_events_excluded, 1);
    assert.equal(catalog.sections.history_tracks.find((row) => row.label === "Thunder Road")?.play_count, 4);
  } finally {
    store.close();
  }
});

test("an album Moondog started keeps every song of it out of the listener's own plays", async () => {
  const store = await openEphemeralListeningHistoryStore();
  try {
    syncPlays(store, [["own1", "Glass Harbor", "The Lanterns", "2026-08-01T10:00:00.000Z"]]);
    store.recordMoondogSuggestions({ entries: [{ service: "spotify", action: "play.album", release: "Night Tide (Deluxe)",
      artists: ["The Lanterns"], requestedAt: "2026-08-10T10:00:00.000Z" }] });
    syncPlays(store, [
      ["alb1", "Tide One", "The Lanterns", "2026-08-10T10:01:00.000Z"],
      ["alb2", "Tide Two", "The Lanterns", "2026-08-10T10:05:00.000Z"],
      ["alb3", "Tide Three", "The Lanterns", "2026-08-10T10:09:00.000Z"],
    ], "Night Tide");
    let catalog = store.profileCatalog({ subjectId });
    assert.equal(catalog.context.moondog_started_events_excluded, 3);
    assert.deepEqual(catalog.sections.history_tracks.map((row) => row.label), ["Glass Harbor"]);
    // A song of it played the next day is the listener's own.
    syncPlays(store, [["alb2", "Tide Two", "The Lanterns", "2026-08-11T20:00:00.000Z"]], "Night Tide");
    catalog = store.profileCatalog({ subjectId });
    assert.equal(catalog.sections.history_tracks.find((row) => row.label === "Tide Two")?.play_count, 1);
    assert.equal(catalog.sections.moondog_suggestions.find((row) => row.label === "Tide Two")?.adopted, true);
  } finally {
    store.close();
  }
});

test("the mix follows new plays after Moondog writes to its ledger", async () => {
  const store = await openEphemeralListeningHistoryStore();
  try {
    syncPlays(store, [["own1", "Glass Harbor", "The Lanterns", "2026-08-01T10:00:00.000Z"]]);
    const tracks = [{ title: "Glass Harbor", artists: ["The Lanterns"] }];
    assert.deepEqual(store.listeningMix({ subjectId, tracks }), ["heard"]);
    // A ledger write alone changes no slot, so the mix keeps its projection.
    store.recordMoondogSuggestions({ entries: [queued("Paper Comet", "The Lanterns", "mdq1", "2026-08-10T10:00:00.000Z")] });
    assert.deepEqual(store.listeningMix({ subjectId, tracks }), ["heard"]);
    syncPlays(store, ["02", "03"].map((day) => ["own1", "Glass Harbor", "The Lanterns", `2026-08-${day}T10:00:00.000Z`]));
    assert.deepEqual(store.listeningMix({ subjectId, tracks }), ["familiar"]);
  } finally {
    store.close();
  }
});

test("starting an album, whole or at one song, writes it to the ledger by its release", async (t) => {
  const recorded = [];
  const service = {
    searchTracks: async () => ({ provider: "spotify", items: [
      { uri: "spotify:track:fictionalHome", id: "fictionalHome", name: "Home", artists: ["Fictional Artist"],
        album: "Home Record", album_uri: "spotify:album:fictionalHomeAlbum" },
      { type: "album", uri: "spotify:album:fictionalAway", name: "Away Record", artists: ["Fictional Artist"] },
      { type: "playlist", uri: "spotify:playlist:fictionalMix", name: "Fictional Mix", artists: [] },
    ] }),
    resume: async () => ({ provider: "spotify", ok: true, effect: "write_external", action: "playback.resume", state: "accepted" }),
  };
  const application = new MoondogApplication({ importsRoot: "/tmp/fictional-ledger-no-imports",
    domainServices: { recordMoondogSuggestions: (entries) => recorded.push(...entries) },
    spotifyConnection: { service, ready: () => true, missingScopes: () => [], publicStatus: () => ({ provider: "spotify", state: "ready" }) } });
  t.after(() => application.close());
  const { items } = await application.spotifySearchTracks({ query: "fictional" });
  for (const item of items) {
    application.beginPrompt({ text: "play it" });
    await application.spotifyControl({ action: "resume", ...(item.type === "track" ? { itemRefId: item.item_ref_id } : { contextRefId: item.item_ref_id }) });
    application.endPrompt();
  }
  assert.deepEqual(recorded.map(({ action, title, release, artists, providerTrackId }) => ({ action, title, release, artists, providerTrackId })), [
    { action: "play", title: "Home", release: undefined, artists: ["Fictional Artist"], providerTrackId: "spotify:track:fictionalHome" },
    { action: "play.album", title: undefined, release: "Home Record", artists: ["Fictional Artist"], providerTrackId: undefined },
    { action: "play.album", title: undefined, release: "Away Record", artists: ["Fictional Artist"], providerTrackId: undefined },
  ]);
});

// A Spotify stand-in whose search finds the given songs and whose writes are recorded.
function spotifyApplication(t, { domainServices, songs, now }) {
  const writes = [];
  const service = {
    searchTracks: async () => ({ provider: "spotify", items: songs.map(([id, name, artists]) => ({
      uri: `spotify:track:${id}`, id, name, artists, album: `${name} Record`, album_uri: `spotify:album:${id}Album` })) }),
    resume: async (parameters) => { writes.push(["resume", parameters]); return { provider: "spotify", ok: true, effect: "write_external", action: "playback.resume", state: "accepted" }; },
    queueTarget: async () => ({ deviceId: "fictionalDevice", active: true }),
    addToQueue: async (parameters) => { writes.push(["queue", parameters]); return { ok: true }; },
    queue: async () => ({ currently_playing: null, queue: [] }),
    createPlaylistWithTracks: async (parameters) => { writes.push(["playlist", parameters]); return { ok: true }; },
  };
  const application = new MoondogApplication({ importsRoot: "/tmp/fictional-ledger-no-imports", domainServices, now,
    spotifyConnection: { service, ready: () => true, missingScopes: () => [], publicStatus: () => ({ provider: "spotify", state: "ready" }) } });
  t.after(() => application.close());
  return { application, writes };
}

async function playSearched(application, text, recentTexts = []) {
  application.beginPrompt({ text, recentTexts });
  try {
    const { items } = await application.spotifySearchTracks({ query: "fictional" });
    return await application.spotifyControl({ action: "resume", itemRefId: items[0].item_ref_id });
  } finally {
    application.endPrompt();
  }
}

test("a song the listener names stays their own, and a song Moondog picks stays Moondog's", async (t) => {
  const store = await openEphemeralListeningHistoryStore();
  t.after(() => store.close());
  syncPlays(store, [["own0", "Salt Road", "The Lanterns", "2026-10-01T10:00:00.000Z"]]);
  const domainServices = createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId });
  let clock = Date.parse("2026-10-10T20:00:00.000Z");
  const now = () => clock;

  // Named in this turn.
  let spotify = spotifyApplication(t, { domainServices, now, songs: [["pink", "Pink Moon", ["Nick Drake"]]] });
  await playSearched(spotify.application, "play Pink Moon by Nick Drake");
  syncPlays(store, [["pink", "Pink Moon", "Nick Drake", "2026-10-10T20:03:00.000Z"]]);

  // An open request: the song is Moondog's pick.
  clock = Date.parse("2026-10-11T20:00:00.000Z");
  spotify = spotifyApplication(t, { domainServices, now, songs: [["ferry", "Night Ferry", ["Mira Vale"]]] });
  await playSearched(spotify.application, "play me something for the drive");
  syncPlays(store, [["ferry", "Night Ferry", "Mira Vale", "2026-10-11T20:03:00.000Z"]]);

  // Named two turns earlier, then played with "play it".
  clock = Date.parse("2026-10-12T20:00:00.000Z");
  spotify = spotifyApplication(t, { domainServices, now, songs: [["harbor", "Harbor Lights", ["The Lanterns"]]] });
  await playSearched(spotify.application, "play it", ["what is Harbor Lights by The Lanterns like?", "is it slow?"]);
  syncPlays(store, [["harbor", "Harbor Lights", "The Lanterns", "2026-10-12T20:03:00.000Z"]]);

  const attention = store.recentAttention({ subjectId, now: Date.parse("2026-10-13T12:00:00.000Z") });
  assert.equal(attention.plays, 3);
  assert.equal(attention.moondog_started_plays, 1);
  assert.deepEqual(attention.top_artists.map((row) => row.name).sort(), ["Nick Drake", "The Lanterns"]);
  const catalog = store.profileCatalog({ subjectId });
  assert.deepEqual(catalog.sections.history_tracks.map((row) => row.label).sort(), ["Harbor Lights", "Pink Moon", "Salt Road"]);
  assert.deepEqual(catalog.sections.moondog_suggestions.map((row) => row.label), ["Night Ferry"]);
  assert.deepEqual(store.listeningMix({ subjectId, tracks: [{ title: "Pink Moon", artists: ["Nick Drake"] }] }), ["heard"]);
  assert.deepEqual(store.moondogSuggestionHistory({ subjectId, tracks: [{ title: "Pink Moon", artists: ["Nick Drake"] }] }), [null]);
});

test("a short or partial title never makes a song the listener's", () => {
  assert.equal(textNamesTitle("play Pink Moon by Nick Drake", "Pink Moon - 2011 Remaster"), true);
  assert.equal(textNamesTitle("play pinkmoon", "Pink Moon"), false);
  assert.equal(textNamesTitle("play something lighter", "Light"), false);
  assert.equal(textNamesTitle("play A", "A"), false);
  assert.equal(textNamesTitle("放一下晴天吧", "晴天"), true);
  assert.equal(textNamesTitle("play Beyoncé's Halo", "Halo"), true);
});

test("Avoid keeps a song out of every Spotify play path, and nothing is sent", async (t) => {
  const store = await openEphemeralListeningHistoryStore();
  t.after(() => store.close());
  syncPlays(store, [["own0", "Salt Road", "The Lanterns", "2026-10-01T10:00:00.000Z"]]);
  const domainServices = createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId });
  domainServices.recordListenerChoice({ entityType: "artist", label: "Beyonce Fictional", stance: "avoid" });
  const { application, writes } = spotifyApplication(t, { domainServices, now: () => Date.parse("2026-10-10T20:00:00.000Z"),
    songs: [["halo", "Fictional Halo", ["Beyoncé Fictional"]]] });
  const blocked = { code: "listener_avoid_blocked" };

  application.beginPrompt({ text: "play Fictional Halo" });
  const { items } = await application.spotifySearchTracks({ query: "fictional" });
  await assert.rejects(application.spotifyControl({ action: "resume", itemRefId: items[0].item_ref_id }), blocked);
  await assert.rejects(application.spotifyAddToQueue({ itemRefId: items[0].item_ref_id }), blocked);
  application.endPrompt();

  const plan = { tracks: [{ track_ref_id: "p1", title: "Harbor Lights", artist_credit: "The Lanterns, Beyoncé Fictional" }] };
  let resolved = 0;
  application.spotifyPlaylistResolver = { resolve: async () => { resolved++; return { resolutions: [] }; } };
  application.pendingSpotifyPlaylist = { plan, trustedTracks: plan.tracks };
  await assert.rejects(application.spotifyPlayPendingPlan(), blocked);
  await assert.rejects(application.spotifyQueuePendingPlan(), blocked);
  await assert.rejects(application.writeSpotifyPlaylist({ name: "Fictional" }, ["spotify:track:p1"], { tracks: plan.tracks }), blocked);
  assert.equal(resolved, 0);
  assert.deepEqual(writes, []);
});

test("a featured artist the listener avoids is kept out of the history candidate sets", async (t) => {
  const store = await openEphemeralListeningHistoryStore();
  t.after(() => store.close());
  const play = (id, name, artists, at) => ({ played_at: at, track: { id, name, artists, album: "Fictional Record", duration_ms: 200_000 }, context_type: "album" });
  store.ingest(projectSpotifyRecentActivity({ subjectId, capturedAt: "2026-10-02T00:00:00.000Z", page: { provider: "spotify", items: [
    ...["01", "02", "03", "04"].map((day) => play("duet", "Harbor Lights", ["The Lanterns", "Nadia Quill"], `2026-01-${day}T10:00:00.000Z`)),
    ...["01", "02", "03", "04"].map((day) => play("solo", "Salt Road", ["The Lanterns"], `2026-01-${day}T11:00:00.000Z`)),
    play("late", "Night Ferry", ["Mira Vale"], "2026-10-01T10:00:00.000Z"),
  ] } }));
  const labels = () => store.rediscoveryCandidates({ subjectId }).tracks.map((track) => track.title).sort();
  assert.deepEqual(labels(), ["Harbor Lights", "Salt Road"]);
  const domainServices = createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId });
  domainServices.recordListenerChoice({ entityType: "artist", label: "Nádia Quill", stance: "avoid" });
  assert.deepEqual(labels(), ["Salt Road"]);
});

test("a ledger write rebuilds neither the Avoid check nor the build input, and a play or a choice does", async (t) => {
  const store = await openEphemeralListeningHistoryStore();
  t.after(() => store.close());
  syncPlays(store, [["own0", "Salt Road", "The Lanterns", "2026-10-01T10:00:00.000Z"]]);
  const counts = { avoids: 0, catalogs: 0 };
  const activeAvoidances = store.activeAvoidances.bind(store);
  const profileCatalog = store.profileCatalog.bind(store);
  store.activeAvoidances = (input) => { counts.avoids++; return activeAvoidances(input); };
  store.profileCatalog = (input) => { counts.catalogs++; return profileCatalog(input); };
  const domainServices = createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId });
  const read = () => { domainServices.filterDiscoveryTracks([{ title: "Salt Road", artist_credit: "The Lanterns" }]); domainServices.getProfileBuildContext(); };
  read();
  assert.deepEqual(counts, { avoids: 1, catalogs: 1 });
  store.recordMoondogSuggestions({ entries: [queued("Paper Comet", "The Lanterns", "mdq1", "2026-10-02T10:00:00.000Z")] });
  read();
  assert.deepEqual(counts, { avoids: 1, catalogs: 1 });
  syncPlays(store, [["own1", "Glass Harbor", "The Lanterns", "2026-10-03T10:00:00.000Z"]]);
  read();
  assert.deepEqual(counts, { avoids: 2, catalogs: 2 });
  domainServices.recordListenerChoice({ entityType: "artist", label: "Mira Vale", stance: "like" });
  read();
  assert.deepEqual(counts, { avoids: 3, catalogs: 3 });
});

// The listening profile projection reads every stored play with this query.
async function countProjections(t) {
  const { StatementSync } = await import("node:sqlite");
  const all = t.mock.method(StatementSync.prototype, "all");
  return () => all.mock.calls.filter((call) => /AS event_json[\s\S]*ORDER BY e\.occurred_at/u.test(call.this.sourceSQL)).length;
}

test("one projection serves the status, the Avoids, the catalog and the mix until the listening data changes", async (t) => {
  const store = await openEphemeralListeningHistoryStore();
  t.after(() => store.close());
  syncPlays(store, [["own1", "Glass Harbor", "The Lanterns", "2026-10-01T10:00:00.000Z"]]);
  const domainServices = createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId });
  domainServices.recordListenerChoice({ entityType: "artist", label: "Mira Vale", stance: "avoid" });
  const projections = await countProjections(t);
  const tracks = [{ title: "Glass Harbor", artists: ["The Lanterns"] }];
  const request = () => {
    const status = domainServices.profileStatus();
    domainServices.filterDiscoveryTracks(tracks);
    store.listeningMix({ subjectId, tracks });
    store.profileSummary({ subjectId, maxItems: 1 });
    store.profileCatalog({ subjectId });
    store.listeningCoverage({ subjectId });
    return status;
  };
  const first = request();
  request();
  assert.equal(projections(), 1);
  // Callers get copies.
  first.listening_sources.push("changed");
  store.activeAvoidances({ subjectId }).push("changed");
  assert.deepEqual(domainServices.profileStatus().listening_sources, ["spotify"]);
  assert.equal(store.activeAvoidances({ subjectId }).length, 1);
  store.recordMoondogSuggestions({ entries: [queued("Paper Comet", "The Lanterns", "mdq1", "2026-10-02T10:00:00.000Z")] });
  request();
  assert.equal(projections(), 1);
  syncPlays(store, [["own2", "Salt Road", "The Lanterns", "2026-10-03T10:00:00.000Z"]]);
  assert.equal(request().effective_listening_events, 2);
  assert.equal(store.listeningCoverage({ subjectId }).sources[0].plays, 2);
  assert.equal(projections(), 2);
});

test("a queue from the other surface keeps this surface's projection, and its plays, choices and checks reach it", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "moondog-surfaces-"));
  const databasePath = path.join(directory, "listening-history.sqlite");
  const terminal = await openListeningHistoryStore({ databasePath });
  const desktop = await openListeningHistoryStore({ databasePath });
  t.after(async () => { terminal.close(); desktop.close(); await rm(directory, { recursive: true, force: true }); });
  syncPlays(desktop, [["own1", "Glass Harbor", "The Lanterns", "2026-10-01T10:00:00.000Z"]]);
  const domainServices = createListeningProfileDomainServices({ listeningHistoryStore: terminal, subjectId });
  const projections = await countProjections(t);
  const tracks = [{ title: "Glass Harbor", artists: ["The Lanterns"] }];
  const request = () => {
    domainServices.profileStatus();
    terminal.listeningMix({ subjectId, tracks });
    return { kept: domainServices.filterDiscoveryTracks(tracks).length, input: domainServices.getProfileBuildContext().input.input_digest };
  };
  const before = request();
  assert.equal(projections(), 1);
  desktop.recordMoondogSuggestions({ entries: [queued("Paper Comet", "The Lanterns", "mdq1", "2026-10-02T10:00:00.000Z")] });
  assert.deepEqual(request(), before);
  assert.equal(projections(), 1);
  // A sync that finds nothing new moves only the checked time.
  syncPlays(desktop, [["own1", "Glass Harbor", "The Lanterns", "2026-10-01T10:00:00.000Z"]]);
  request();
  assert.equal(projections(), 1);
  assert.equal(terminal.listeningCoverage({ subjectId }).recent_plays_checked_at, "2026-10-01T10:01:00.000Z");
  syncPlays(desktop, [["own2", "Salt Road", "The Lanterns", "2026-10-03T10:00:00.000Z"]]);
  assert.notEqual(request().input, before.input);
  assert.equal(projections(), 2);
  assert.equal(domainServices.profileStatus().effective_listening_events, 2);
  desktop.recordListenerCorrection({ subjectId, entityType: "artist", label: "The Lanterns", stance: "avoid" });
  assert.equal(request().kept, 0);
  assert.equal(projections(), 3);
});

test("plays of one stored track share its match, and each play keeps its own time window", () => {
  const track = { track_ref_id: "fictional-track", revision: 1, title: "Glass Harbor", artist_credits: [{ name: "The Lanterns" }],
    release: { title: "Fictional Record" } };
  const play = (occurredAt) => ({ event: { occurred_at: occurredAt }, track: structuredClone(track) });
  const unstored = { event: { occurred_at: "2026-10-01T10:05:00.000Z" }, track: { title: "Glass Harbor", artists: ["The Lanterns"] } };
  const suggestion = { suggestion_id: "s1", provider_track_id: null, isrc: null, track_key: songKeys(track)[0], release_key: null,
    title: "Glass Harbor", artist_credit: "The Lanterns", requested_at: "2026-10-01T10:00:00.000Z" };
  const { rows, adopted } = markMoondogStartedPlays(
    [play("2026-10-01T09:00:00.000Z"), play("2026-10-01T10:04:00.000Z"), play("2026-10-02T10:00:00.000Z"), unstored], [suggestion]);
  assert.deepEqual(rows.map((row) => row.moondog_suggestion_id ?? null), [null, "s1", null, "s1"]);
  assert.deepEqual([...adopted], ["s1"]);
});

test("a play that ended before Moondog's request is the listener's own", async (t) => {
  const store = await openEphemeralListeningHistoryStore();
  t.after(() => store.close());
  syncPlays(store, [
    ["glass", "Glass Harbor", "The Lanterns", "2026-10-10T08:00:00.000Z"],
    ["glass", "Glass Harbor", "The Lanterns", "2026-10-10T09:58:00.000Z"],
  ]);
  const before = store.profileEvidenceRevision({ subjectId });
  store.recordMoondogSuggestions({ entries: [{ ...queued("Glass Harbor", "The Lanterns", "glass", "2026-10-10T10:00:00.000Z"), action: "play" }] });
  const now = Date.parse("2026-10-10T12:00:00.000Z");
  assert.deepEqual([store.recentAttention({ subjectId, now }).plays, store.recentAttention({ subjectId, now }).moondog_started_plays], [2, undefined]);
  assert.equal(store.profileEvidenceRevision({ subjectId }), before);
  // Moondog's replay ends at 10:04 and is Moondog's.
  syncPlays(store, [["glass", "Glass Harbor", "The Lanterns", "2026-10-10T10:04:00.000Z"]]);
  const attention = store.recentAttention({ subjectId, now });
  assert.deepEqual([attention.plays, attention.moondog_started_plays], [2, 1]);
  assert.equal(store.profileCatalog({ subjectId }).sections.history_tracks.find((row) => row.label === "Glass Harbor")?.play_count, 2);
});

test("an Apple library song with plays is heard or familiar in the mix", () => {
  const libraryTrack = (title, plays) => ({ track_ref: { track_ref_id: `apple-${title}` }, title, artist_credit: "The Lanterns",
    release: "Fictional Record", observation_summary: { play_count: plays } });
  const projection = { searchLibrary: ({ query }) => ({ tracks: [libraryTrack("Glass Harbor", 140), libraryTrack("Salt Road", 1)]
    .filter((track) => track.title.toLowerCase() === query) }) };
  const services = new AppleProjectionDomainServices({ projection });
  assert.deepEqual(services.listeningMix([
    { title: "Glass Harbor - 2011 Remaster", artist_credit: "The Lanterns" },
    { title: "Salt Road", artists: ["The Lanterns"] },
    { title: "Unwritten", artist_credit: "Nobody Known" },
  ]), ["familiar", "heard", "unknown"]);
});

test("an Apple Music set returns its mix, one song none, and a named album stays out of the ledger", async (t) => {
  const recorded = [];
  const application = new MoondogApplication({ importsRoot: "/tmp/fictional-ledger-no-imports",
    domainServices: { filterDiscoveryTracks: (tracks) => tracks, recordMoondogSuggestions: (entries) => recorded.push(...entries),
      listeningMix: (tracks) => tracks.map((track) => track.title === "Glass Harbor" ? "familiar" : "new") },
    musicCatalog: {
      findArtistReleases: async () => ({}),
      findPreview: async ({ title, artist }) => ({ state: "resolved", track: { title, artist_credit: artist, catalog_id: title } }),
      findAlbumPreviews: async ({ title, artist }) => ({ state: "resolved", album: { title, artist_credit: artist },
        tracks: [{ title: "Tide One", artist_credit: artist }, { title: "Tide Two", artist_credit: artist }] }),
    },
    musicPreviewPlayer: { play: async () => {} } });
  t.after(() => application.close());
  const set = await application.playMusicPreview({ tracks: [{ title: "Glass Harbor", artist: "The Lanterns" }, { title: "Night Ferry", artist: "Mira Vale" }] });
  assert.deepEqual(set.mix, { familiar: 1, returning: 0, heard: 0, known_artist: 0, new: 1 });
  assert.equal((await application.playMusicPreview({ tracks: [{ title: "Night Ferry", artist: "Mira Vale" }] })).mix, undefined);
  assert.equal(recorded.length, 3);
  application.beginPrompt({ text: "play the album Night Tide by The Lanterns" });
  await application.playMusicPreview({ album: { title: "Night Tide", artist: "The Lanterns" } });
  application.endPrompt();
  assert.equal(recorded.length, 3);
});
