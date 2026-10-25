import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { exactTitleArtistMatch } from "../../src/core/apple-projection-domain-services.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { normalizedTrackTitle } from "../../src/core/track-title.mjs";
import { projectSpotifyRecentActivity } from "../../src/integrations/spotify/recent-activity.mjs";
import { listenerProfileDossier, createListenerProfileInput } from "../../src/profile/listener-profile-build.mjs";
import {
  openEphemeralListeningHistoryStore,
  openListeningHistoryStore,
} from "../../src/profile/listening-history-store.mjs";

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
    // A song Moondog played does not make it familiar.
    store.recordMoondogSuggestions({ entries: [queued("Night Ferry", "Mira Vale", "t4", "2026-07-05T09:00:00.000Z")] });
    syncPlays(store, ["10:00", "10:05", "10:10"].map((time) => ["t4", "Night Ferry", "Mira Vale", `2026-07-05T${time}:00.000Z`]));
    assert.deepEqual(store.listeningMix({ subjectId, tracks: [
      { title: "Glass Harbor - 2011 Remaster", artists: ["The Lanterns"] },
      { title: "Old Lighthouse", artist_credit: "Mira Vale, Guest" },
      { title: "Salt Road (Live)", artists: ["The Lanterns"] },
      { title: "Night Ferry", artists: ["Mira Vale"] },
      { title: "Unwritten", artists: ["Nobody Known"] },
    ] }), ["familiar", "returning", "heard", "known_artist", "new"]);
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
