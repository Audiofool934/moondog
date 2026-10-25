import assert from "node:assert/strict";
import test from "node:test";

import { createListeningProfileDomainServices } from "../../src/core/listening-profile-domain-services.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { textNames, textNamesArtist, textNamesSong } from "../../src/core/track-title.mjs";
import { projectSpotifyRecentActivity } from "../../src/integrations/spotify/recent-activity.mjs";
import { openEphemeralListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";

const subjectId = "33333333-3333-4333-8333-333333333333";

test("a Latin name inside Chinese, Japanese or Korean text is named, and only as a whole word", () => {
  for (const text of ["我不想再听Mira Vale了", "Mira Valeはもう聴きたくない", "Mira Vale는 이제 그만 틀어줘", "放一下Mira Vale的歌"]) {
    assert.equal(textNames(text, "Mira Vale"), true, text);
  }
  assert.equal(textNames("放一下Yellowbird", "Yellowbird"), true);
  assert.equal(textNames("我想听Creep", "Creep"), true);
  assert.equal(textNames("放一下Taylor Fictional的Love Story", "Love Story"), true);
  assert.equal(textNames("I love coldplayer", "Coldplay"), false);
  assert.equal(textNames("我喜欢Coldplayer", "Coldplay"), false);
  assert.equal(textNames("我喜欢xColdplay", "Coldplay"), false);
  assert.equal(textNames("放一下晴天吧", "晴天"), true);
  assert.equal(textNamesArtist("no more Lanterns please", "The Lanterns"), true);
  assert.equal(textNamesArtist("nunca más Lobos Fictivos", "Los Lobos Fictivos"), true);
  assert.equal(textNamesArtist("the band is fine", "The The"), false);
});

test("a song is the listener's only when they name its title with an artist, or quote the title", () => {
  assert.equal(textNamesSong("play me something for a rainy day", "Rainy Day", ["Fictional Moodmaker"]), false);
  assert.equal(textNamesSong("放点安静的歌，适合下雨天", "下雨天", ["虚构歌手"]), false);
  assert.equal(textNamesSong("play Pink Moon by Nick Drake", "Pink Moon - 2011 Remaster", ["Nick Drake"]), true);
  assert.equal(textNamesSong("放周杰伦的晴天", "晴天", ["周杰伦"]), true);
  for (const text of ["play “Pink Moon”", "play \"Pink Moon\"", "play 'Pink Moon' now", "don’t skip ‘Pink Moon’",
    "放《晴天》", "「Pink Moon」をかけて", "『Pink Moon』", "mets « Pink Moon »"]) {
    assert.equal(textNamesSong(text, text.includes("晴天") ? "晴天" : "Pink Moon", ["Fictional"]), true, text);
  }
  // A known limit: a bare title with no artist and no quotes is Moondog's pick.
  assert.equal(textNamesSong("play Pink Moon", "Pink Moon", ["Nick Drake"]), false);
});

// A Spotify stand-in whose search finds the given songs, with a ledger that records each entry.
function spotifyApplication(t, songs, { domainServices = {}, writes = [], resolver } = {}) {
  const recorded = [];
  const service = {
    searchTracks: async () => ({ provider: "spotify", items: songs.map(([id, name, artists]) => ({
      uri: `spotify:track:${id}`, id, name, artists, album: `${name} Record` })) }),
    resume: async (parameters) => { writes.push(["resume", parameters]); return { provider: "spotify", ok: true, effect: "write_external", action: "playback.resume", state: "accepted" }; },
    queueTarget: async () => ({ deviceId: "fictionalDevice", active: true }),
    addToQueue: async (parameters) => { writes.push(["queue", parameters.uri]); return { ok: true }; },
    queue: async () => ({ currently_playing: null, queue: [] }),
    currentPlayer: async () => null,
    createPlaylistWithTracks: async (parameters) => { writes.push(["playlist", parameters.uris]);
      return { provider: "spotify", ok: true, effect: "write_external", action: "playlist.write", state: "accepted",
        playlist: { name: parameters.name, track_count: parameters.uris.length } }; },
  };
  const application = new MoondogApplication({ importsRoot: "/tmp/fictional-naming-no-imports",
    domainServices: { recordMoondogSuggestions: (entries) => recorded.push(...entries), ...domainServices },
    spotifyConnection: { service, resolver, ready: () => true, missingScopes: () => [], publicStatus: () => ({ provider: "spotify", state: "ready" }) } });
  t.after(() => application.close());
  return { application, recorded, writes };
}

async function playFirst(t, text, song) {
  const { application, recorded } = spotifyApplication(t, [song]);
  application.beginPrompt({ text });
  const { items } = await application.spotifySearchTracks({ query: "fictional" });
  await application.spotifyControl({ action: "resume", itemRefId: items[0].item_ref_id });
  application.endPrompt();
  return recorded.map((entry) => entry.title);
}

test("mood words make no pick the listener's, and a song they name stays theirs", async (t) => {
  assert.deepEqual(await playFirst(t, "play me something for a rainy day", ["rain", "Rainy Day", ["Fictional Moodmaker"]]), ["Rainy Day"]);
  assert.deepEqual(await playFirst(t, "play Pink Moon by Nick Drake", ["pink", "Pink Moon", ["Nick Drake"]]), []);
  assert.deepEqual(await playFirst(t, "放周杰伦的晴天", ["sunny", "晴天", ["周杰伦"]]), []);
  assert.deepEqual(await playFirst(t, "play “Pink Moon”", ["pink", "Pink Moon", ["Nick Drake"]]), []);
  assert.deepEqual(await playFirst(t, "play Pink Moon", ["pink", "Pink Moon", ["Nick Drake"]]), ["Pink Moon"]);
});

test("a queue of dictated songs and fill-ins puts only the fill-ins in the ledger", async (t) => {
  const { application, recorded, writes } = spotifyApplication(t, [
    ["pink", "Pink Moon", ["Nick Drake"]], ["river", "River Man", ["Nick Drake"]], ["place", "Place To Be", ["Nick Drake"]],
    ["ferry", "Night Ferry", ["Mira Vale"]], ["harbor", "Harbor Lights", ["The Lanterns"]],
  ]);
  application.beginPrompt({ text: "queue Pink Moon, River Man and Place To Be by Nick Drake, then two more like them" });
  const { items } = await application.spotifySearchTracks({ query: "fictional" });
  const receipt = await application.spotifyQueueBatch({ itemRefs: items.map((item) => item.item_ref_id) });
  application.endPrompt();
  assert.equal(receipt.queued_count, 5);
  assert.equal(writes.length, 5);
  assert.deepEqual(recorded.map((entry) => [entry.title, entry.action]), [["Night Ferry", "queue.batch"], ["Harbor Lights", "queue.batch"]]);
});

test("an Apple Music set keeps the named song the listener's and the rest Moondog's", async (t) => {
  const recorded = [];
  const application = new MoondogApplication({ importsRoot: "/tmp/fictional-naming-no-imports",
    domainServices: { filterDiscoveryTracks: (tracks) => tracks, recordMoondogSuggestions: (entries) => recorded.push(...entries) },
    musicCatalog: {
      findArtistReleases: async () => ({}),
      findPreview: async ({ title, artist }) => ({ state: "resolved", track: { title, artist_credit: artist, catalog_id: title } }),
    },
    musicPreviewPlayer: { play: async () => {} } });
  t.after(() => application.close());
  application.beginPrompt({ text: "play Glass Harbor by The Lanterns, then some late night songs about love" });
  await application.playMusicPreview({ tracks: [{ title: "Glass Harbor", artist: "The Lanterns" },
    { title: "Night", artist: "Mira Vale" }, { title: "Love", artist: "Fictional Moodmaker" }] });
  application.endPrompt();
  assert.deepEqual(recorded.map((entry) => entry.title), ["Night", "Love"]);
});

test("a NetEase set ledgers mood-word titles as Moondog's and a song the listener named as theirs", async (t) => {
  const recorded = [];
  const player = { ready: () => true,
    play: async ({ items }) => ({ mode: "playing", songs: items.map((item, index) => ({ id: `fictional${index}`, title: item.title, artists: [item.artist] })) }) };
  const application = new MoondogApplication({ importsRoot: "/tmp/fictional-naming-no-imports", neteasePlayer: player, playbackService: "netease",
    domainServices: { filterDiscoveryTracks: (tracks) => tracks, recordMoondogSuggestions: (entries) => recorded.push(...entries) } });
  t.after(() => application.close());
  const songs = [{ title: "安静", artist: "虚构歌手" }, { title: "下雨天", artist: "虚构乐队" }, { title: "晴天", artist: "周杰伦" }];
  application.beginPrompt({ text: "放点安静的歌，适合下雨天" });
  await application.playNetease({ items: songs });
  application.endPrompt();
  assert.deepEqual(recorded.map((entry) => entry.title), ["安静", "下雨天", "晴天"]);
  recorded.length = 0;
  application.beginPrompt({ text: "放周杰伦的晴天，再来两首安静的" });
  await application.playNetease({ items: songs });
  application.endPrompt();
  assert.deepEqual(recorded.map((entry) => entry.title), ["安静", "下雨天"]);
});

// Fictional plays as the recent-play sync reads them.
function syncPlays(store, plays) {
  return store.ingest(projectSpotifyRecentActivity({
    subjectId,
    capturedAt: "2026-10-02T10:00:00.000Z",
    page: { provider: "spotify", items: plays.map(([id, name, artists, playedAt]) => ({
      played_at: playedAt, track: { id, name, artists, album: `${name} Record`, duration_ms: 200_000 }, context_type: "album" })) },
  }));
}

test("a plan reads a band's credit as the candidate gate did, and leaves out only the song avoided since", async (t) => {
  const store = await openEphemeralListeningHistoryStore();
  t.after(() => store.close());
  syncPlays(store, [["own0", "Salt Road", ["The Lanterns"], "2026-10-01T10:00:00.000Z"]]);
  const domainServices = createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId });
  domainServices.recordListenerChoice({ entityType: "artist", label: "Salt", stance: "avoid" });
  domainServices.recordListenerChoice({ entityType: "artist", label: "Mira Vale", stance: "avoid" });
  const writes = [];
  const resolvedRefs = [];
  const resolver = { resolve: async (trusted) => {
    resolvedRefs.push(trusted.map((track) => track.track_ref_id));
    return { resolutions: trusted.map((track) => ({ track_ref_id: track.track_ref_id, status: "resolved", spotify: { uri: `spotify:track:${track.track_ref_id}` } })) };
  } };
  const { application, recorded } = spotifyApplication(t, [], { domainServices: {
    filterDiscoveryTracks: (tracks) => domainServices.filterDiscoveryTracks(tracks) }, writes, resolver });
  const tracks = [
    { track_ref_id: "p1", title: "Ember Song", artist_credit: "Salt, Wind & Ember", candidate_scope: "private_history" },
    { track_ref_id: "p2", title: "Harbor Lights", artist_credit: "The Lanterns", candidate_scope: "private_history" },
    { track_ref_id: "p3", title: "Night Ferry", artist_credit: "Mira Vale", candidate_scope: "private_history" },
  ];
  const pending = () => { application.pendingSpotifyPlaylist = { plan: { tracks }, trustedTracks: tracks }; };
  const leftOut = [{ title: "Night Ferry", artist_credit: "Mira Vale" }];

  pending();
  const played = await application.spotifyPlayPendingPlan();
  assert.equal(played.track_count, 2);
  assert.deepEqual(played.skipped_avoided, leftOut);
  assert.deepEqual(writes.at(-1), ["resume", { uris: ["spotify:track:p1", "spotify:track:p2"] }]);

  pending();
  const queued = await application.spotifyQueuePendingPlan();
  assert.deepEqual(queued.queued.map((track) => track.title), ["Ember Song", "Harbor Lights"]);
  assert.deepEqual(queued.skipped_avoided, leftOut);
  assert.equal(queued.skipped_avoided_count, 1);

  pending();
  const saved = await application.spotifyCreatePendingPlaylist({ name: "Fictional Evening" });
  assert.deepEqual(saved.skipped_avoided, leftOut);
  assert.deepEqual(writes.at(-1), ["playlist", ["spotify:track:p1", "spotify:track:p2"]]);
  // The avoided song is never even looked up.
  assert.deepEqual(resolvedRefs, [["p1", "p2"], ["p1", "p2"], ["p1", "p2"]]);
  assert.equal(recorded.some((entry) => entry.title === "Night Ferry"), false);
  assert.equal(recorded.filter((entry) => entry.title === "Ember Song").length, 3);

  // A plan with nothing left is refused, and nothing is sent.
  const sent = writes.length;
  application.pendingSpotifyPlaylist = { plan: { tracks: [tracks[2]] }, trustedTracks: [tracks[2]] };
  await assert.rejects(application.spotifyPlayPendingPlan(), { code: "listener_avoid_blocked" });
  assert.equal(writes.length, sent);
});
