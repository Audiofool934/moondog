import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createAppleProjectionDomainServices } from "../../src/core/apple-projection-domain-services.mjs";
import { createAvoidGate } from "../../src/core/listener-avoids.mjs";
import { createListeningProfileDomainServices } from "../../src/core/listening-profile-domain-services.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createNeteasePlayer } from "../../src/integrations/netease/ncm-cli-player.mjs";
import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";
const artist = (label) => ({ entity_type: "artist", label });

test("an artist Avoid matches the whole credit and every credited artist, however it is written", () => {
  const gate = createAvoidGate([artist("Drake"), artist("Sigur Rós"), artist("周杰伦"), artist("Simon & Garfunkel")]);
  for (const credit of ["Drake & Future", "Future feat. Drake", "Drake ", "future FT. drake", "Future, Drake", "Future x Drake",
    "Drake with Future", "Sigur Ros", "sigur  rós", "林俊杰、周杰伦", "林俊杰，周杰伦", "Simon & Garfunkel", "Simon & Garfunkel, Paul Simon"]) {
    assert.equal(gate.avoidsTrack({ title: "Fictional Song", artist_credit: credit }), true, credit);
  }
  for (const credit of ["Drakeo the Ruler", "Future", "Sigur", "Simon", "Art Garfunkel"]) {
    assert.equal(gate.avoidsTrack({ title: "Fictional Song", artist_credit: credit }), false, credit);
  }
  // A source's own list of artists counts as well as its credit line.
  assert.equal(gate.avoidsTrack({ title: "Fictional Song", artist_credit: "Various", artists: ["Future", "Drake"] }), true);
  // Kana voicing marks are part of the word, not accents.
  assert.equal(createAvoidGate([artist("カナ")]).avoidsArtist("ガナ"), false);
});

test("a track Avoid matches its title with any of its artists, and nothing else by them", () => {
  const gate = createAvoidGate([{ entity_type: "track", label: "Night Song", artist_credit: "Mara Vale" }]);
  assert.equal(gate.avoidsTrack({ title: "night song ", artist_credit: "Mara Vale feat. Aster North" }), true);
  assert.equal(gate.avoidsTrack({ title: "Night Song", artist_credit: "Aster North" }), false);
  assert.equal(gate.avoidsTrack({ title: "Day Song", artist_credit: "Mara Vale" }), false);
});

test("features named in a title count as credited artists, and a track Avoid ignores them", () => {
  const gate = createAvoidGate([artist("Drake"), { entity_type: "track", label: "Night Song", artist_credit: "Mara Vale" }]);
  for (const title of ["Life Is Good (feat. Drake)", "Life Is Good [with Drake]", "Life Is Good feat. Drake", "Life Is Good - ft. Drake & Aster North"]) {
    assert.equal(gate.avoidsTrack({ title, artist_credit: "Future" }), true, title);
  }
  assert.equal(gate.avoidsTrack({ title: "Dancing with Drakes", artist_credit: "Future" }), false);
  assert.equal(gate.avoidsTrack({ title: "Night Song (feat. Aster North)", artist_credit: "Mara Vale" }), true);
});

test("a name that ends in X keeps the artists after it, and a source's own artist list is read whole", () => {
  const gate = createAvoidGate([artist("Jack Harlow"), artist("Earth")]);
  for (const credit of ["Lil Nas X feat. Jack Harlow", "Lil Nas X with Jack Harlow", "Lil Nas X x Jack Harlow"]) {
    assert.equal(gate.avoidsTrack({ title: "Fictional Song", artist_credit: credit }), true, credit);
  }
  assert.equal(gate.avoidsTrack({ title: "Fictional Song", artist_credit: "Earth, Wind & Fire", artists: ["Earth, Wind & Fire"] }), false);
  assert.equal(gate.avoidsTrack({ title: "Fictional Song", artist_credit: "Earth, Wind & Fire", artists: ["Earth", "Wind & Fire"] }), true);
  // Free text could be either, so the Avoid holds.
  assert.equal(gate.avoidsTrack({ title: "Fictional Song", artist_credit: "Earth, Wind & Fire" }), true);
});

async function openStore(t) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-avoid-gate-"));
  const store = await openListeningHistoryStore({ databasePath: path.join(root, "history.sqlite") });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return store;
}

test("the Avoid check is kept until a choice changes, for history and Apple services alike", async (t) => {
  const store = await openStore(t);
  const reads = t.mock.method(store, "activeAvoidances");
  const services = [
    createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId }),
    createAppleProjectionDomainServices({ listeningHistoryStore: store, subjectId,
      projection: { searchLibrary: () => ({ tracks: [] }), close() {} } }),
  ];
  const track = { title: "Fictional Song", artist_credit: "Future feat. Drake" };
  for (const service of services) assert.equal(service.filterDiscoveryTracks([track]).length, 1);
  for (const service of services) assert.equal(service.filterDiscoveryTracks([track]).length, 1);
  assert.equal(reads.mock.callCount(), 2, "one read each until the data changes");
  store.recordListenerCorrection({ subjectId, entityType: "artist", label: "Drake", stance: "avoid" });
  for (const service of services) assert.equal(service.filterDiscoveryTracks([track]).length, 0);
  assert.equal(reads.mock.callCount(), 4);
});

test("Apple catalog candidates keep the storefront they came from", async (t) => {
  const store = await openStore(t);
  const services = createAppleProjectionDomainServices({ listeningHistoryStore: store, subjectId,
    projection: { searchLibrary: () => ({ tracks: [] }), close() {} } });
  const tracks = [{ track_ref_id: "22222222-2222-4222-8222-222222222222", title: "Fictional Song",
    artist_credit: "Fictional Artist", release: "Fictional Album", candidate_scope: "external_catalog", catalog_provider: "apple_music" }];
  const source = (storefront) => ({ provider: "apple_music", catalog: "itunes_search_api", storefront,
    retrieved_at: "2026-10-25T00:00:00.000Z", coverage: "Fictional catalog." });
  for (const storefront of ["CN", "GB"]) {
    assert.equal(services.registerExternalCandidateSet({ tracks, source: source(storefront) }).source.storefront, storefront);
  }
  for (const storefront of ["cn", "GBR", undefined]) {
    assert.throws(() => services.registerExternalCandidateSet({ tracks, source: source(storefront) }), /source metadata is invalid/u);
  }
});

test("NetEase and Apple Music previews leave out Avoids and say how many", async (t) => {
  const store = await openStore(t);
  store.recordListenerCorrection({ subjectId, entityType: "artist", label: "Drake", stance: "avoid" });
  const domainServices = createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId });

  const records = [
    { id: "A1", originalId: 1, name: "Fictional Duet", artists: [{ name: "Future" }, { name: "Drake" }], visible: true },
    { id: "B2", originalId: 2, name: "Fictional Solo", artists: [{ name: "Future" }], visible: true },
  ];
  const run = async (args) => {
    if (args[0] === "login") return { success: true, message: "signed in" };
    if (args[0] === "search") return { code: 200, data: { records: records.filter((record) => args[3].includes(record.name)) } };
    if (args[0] === "state") return { success: true, state: { status: "playing", title: "Fictional Solo - Future", currentIndex: 0, queueLength: 0 } };
    return { success: true };
  };
  const player = createNeteasePlayer({ run, wait: async () => {} });
  await player.check();
  const netease = new MoondogApplication({ domainServices, neteasePlayer: player, playbackService: "netease" });
  const played = await netease.playNetease({ items: [{ title: "Fictional Duet", artist: "Future" },
    { title: "Fictional Solo", artist: "Future" }, { title: "Another Song", artist: "Drake & Future" }], intent: "fictional" });
  assert.deepEqual(played.songs.map((song) => song.title), ["Fictional Solo"]);
  assert.equal(played.skipped_avoided_count, 2);

  const heard = [];
  const catalog = {
    findArtistReleases: async () => ({ state: "not_found" }),
    findPreview: async ({ title, artist: credit }) => ({ state: "resolved", track: { title, artist_credit: credit === "Future" && title === "Hidden Duet" ? "Future feat. Drake" : credit } }),
    findAlbumPreviews: async () => ({ state: "resolved", album: { title: "Fictional Album", artist_credit: "Future" },
      tracks: [{ title: "Intro", artist_credit: "Future" }, { title: "Duet", artist_credit: "Future & Drake" }] }),
  };
  const previews = new MoondogApplication({ domainServices, musicCatalog: catalog, playbackService: "apple_music",
    musicPreviewPlayer: { play: async (tracks) => { heard.push(tracks.map((track) => track.title)); } } });
  const songs = await previews.playMusicPreview({ tracks: [{ title: "Hidden Duet", artist: "Future" },
    { title: "Fictional Solo", artist: "Future" }, { title: "Any Song", artist: "Drake" }] });
  assert.deepEqual(songs.played.map((track) => track.title), ["Fictional Solo"]);
  assert.equal(songs.skipped_avoided_count, 2);
  const album = await previews.playMusicPreview({ album: { title: "Fictional Album", artist: "Future" } });
  assert.deepEqual(album.played.map((track) => track.title), ["Intro"]);
  assert.equal(album.skipped_avoided_count, 1);
  assert.deepEqual(heard, [["Fictional Solo"], ["Intro"]]);
});

test("Avoids that could not be loaded stop NetEase, previews and Spotify alike", async () => {
  const calls = [];
  const player = createNeteasePlayer({ run: async (args) => { calls.push(args[0]);
    return args[0] === "login" ? { success: true, message: "signed in" } : { code: 200, data: { records: [] } }; }, wait: async () => {} });
  await player.check();
  calls.length = 0;
  const broken = { domainServices: null, domainServicesError: "projection_source_invalid" };
  const unavailable = { code: "listener_avoids_unavailable" };
  const netease = new MoondogApplication({ ...broken, neteasePlayer: player, playbackService: "netease" });
  await assert.rejects(netease.playNetease({ items: [{ title: "Fictional Song", artist: "Future" }] }), unavailable);
  assert.deepEqual(calls, [], "nothing was looked up or played");
  const previews = new MoondogApplication({ ...broken, playbackService: "apple_music",
    musicCatalog: { findArtistReleases: async () => ({ state: "not_found" }), findPreview: async () => { calls.push("preview"); return { state: "not_found" }; } },
    musicPreviewPlayer: { play: async () => { calls.push("play"); } } });
  await assert.rejects(previews.playMusicPreview({ tracks: [{ title: "Fictional Song", artist: "Future" }] }), unavailable);
  assert.throws(() => previews.spotifyDiscoveryAllowed({ name: "Fictional Song", artists: ["Future"] }), unavailable);
  assert.deepEqual(calls, []);
});
