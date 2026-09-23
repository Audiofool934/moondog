import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { prepareHistoryImport } from "../../src/profile/history-import.mjs";
import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";
import { createListeningHistoryProfileProjection } from "../../src/profile/spotify-archive-taste.mjs";
import { parseMusicCsv } from "../../src/integrations/youtube-music/takeout.mjs";
import { createContractValidator, contractSchemaIds } from "../../scripts/contract-lib.mjs";

const exec = promisify(execFile);
const subjectId = "11111111-1111-4111-8111-111111111111";
const capturedAt = "2026-09-23T00:00:00.000Z";
const songId = "Abcdefgh_12";
const csv = `\uFEFFVideo ID,Song Title,Album Title,Artist Name\r\n${songId},"Moon, \"\"light\"\"\n夜",Sky,Example Artist\r\n`;
const watched = { header: "YouTube Music", title: "Watched Moon", titleUrl: `https://www.youtube.com/watch?v=${songId}`, time: "2026-01-01T10:00:00Z", subtitles: [{ name: "Not necessarily the artist" }] };

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-music-import-"));
  const store = await openListeningHistoryStore({ environment: { MOONDOG_STATE_HOME: path.join(root, "state") } });
  store.localSubjectId({ preferredSubjectId: subjectId, create: true });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, prepare: (filePath, options = {}) => prepareHistoryImport({ filePath, subjectId, capturedAt, ...options }) };
}

test("Takeout ZIP previews music only, validates contracts, and imports a cumulative deduplicated profile", async (t) => {
  const { root, store, prepare } = await fixture(t);
  const folder = path.join(root, "Takeout", "YouTube and YouTube Music");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "music-library-songs.csv"), csv);
  await writeFile(path.join(folder, "watch-history.json"), JSON.stringify([
    watched, watched, { ...watched, time: "2026-01-02T10:00:00Z" },
    { ...watched, header: "YouTube", title: "Watched ordinary video" },
    { ...watched, time: "invalid" }, { ...watched, time: "2030-01-01T00:00:00Z" },
    { ...watched, titleUrl: "https://attacker.example/watch?v=Abcdefgh_12" },
  ]));
  await writeFile(path.join(folder, "comments.json"), '{"private":"ignored"}');
  const archive = path.join(root, "takeout-test.zip");
  await exec("zip", ["-qr", archive, "Takeout"], { cwd: root });
  const prepared = await prepare(archive);
  assert.equal(prepared.provider, "youtube_music");
  assert.equal(prepared.preview.listeningEvents, 2);
  assert.equal(prepared.preview.profileEvidence, 1);
  assert.equal(prepared.preview.skippedRecords, 4);
  assert.equal(prepared.bundle.track_refs[0].artist_credits[0].name, "Example Artist");
  assert.equal(prepared.bundle.track_refs[0].title, 'Moon, "light" 夜');
  assert.equal(JSON.stringify(prepared).includes("private"), false);
  assert.ok(prepared.bundle.listening_events.every((event) => event.played_ms === undefined));
  const { ajv } = await createContractValidator();
  for (const [type, rows] of [["track-ref", prepared.bundle.track_refs], ["listening-event", prepared.bundle.listening_events]]) {
    const validate = ajv.getSchema(contractSchemaIds.get(type));
    for (const row of rows) assert.ok(validate(row), JSON.stringify(validate.errors));
  }
  await writeFile(archive, "changed after preview");
  assert.equal(store.ingestImport(prepared.bundle).inserted_events, 2);
  assert.equal(store.ingestImport(prepared.bundle).already_imported, true);
  // The same activity in an extracted file also overlaps, rather than adding plays.
  const extracted = await prepare(path.join(folder, "watch-history.json"));
  assert.equal(store.ingestImport(extracted.bundle).inserted_events, 0);
  const listening = store.profileSummary({ subjectId });
  assert.equal(listening.coverage.effective_listening_events, 2);
  assert.equal(listening.coverage.listening_hours, 0);
  assert.deepEqual(listening.source.providers, ["youtube_music"]);
  const profile = createListeningHistoryProfileProjection(listening);
  assert.equal(profile.coverage.spotify_saved_tracks, 0);
  assert.equal(profile.coverage.saved_tracks, 1);
  assert.match(profile.strong_preferences[0].signal, /YouTube Music/u);
});

test("library alone is useful without fabricated listening; wrong formats fail with a recovery path", async (t) => {
  const { root, store, prepare } = await fixture(t);
  const file = path.join(root, "music-library-songs.csv");
  await writeFile(file, csv);
  const prepared = await prepare(file);
  assert.equal(prepared.preview.kind, "collection");
  assert.equal(store.ingestImport(prepared.bundle).inserted_events, 0);
  assert.equal(store.profileSummary({ subjectId }).coverage.collection_tracks, 1);
  await writeFile(file, "Video ID,Playlist Video Creation Timestamp\nAbcdefgh_12,2026-01-01");
  await assert.rejects(prepare(file), /General YouTube playlist/u);
  assert.throws(() => parseMusicCsv('a,b\n"unclosed'), /Incomplete/u);
  assert.throws(() => parseMusicCsv('a,b\n"closed"junk,x'), /Malformed/u);
  const history = path.join(root, "watch-history.json");
  await writeFile(history, JSON.stringify([{ ...watched, header: "YouTube" }]));
  await assert.rejects(prepare(history), /No supported music records/u);
});

test("history without a library keeps video titles but never ranks a channel or unknown placeholder as an artist", async (t) => {
  const { root, store, prepare } = await fixture(t);
  const file = path.join(root, "watch-history.json");
  await writeFile(file, JSON.stringify([watched, { ...watched, title: "Visited Moon" }]));
  const prepared = await prepare(file);
  assert.equal(prepared.preview.listeningEvents, 1);
  assert.equal(prepared.preview.skippedRecords, 1);
  assert.equal(prepared.bundle.track_refs[0].artist_credits, undefined);
  store.ingestImport(prepared.bundle);
  const profile = store.profileSummary({ subjectId });
  assert.deepEqual(profile.listening_behavior.enduring_artists, []);
  assert.equal(profile.listening_behavior.repeat_tracks[0].label, "Moon");
  assert.equal(profile.listening_behavior.history_arc[0].top_artist, undefined);
});

function playlistData(qq = false) {
  return qq ? { code: 0, subcode: 0, cdlist: [{ disstid: "1234", dir_show: 1, dissname: "Selected QQ playlist", total_song_num: 3,
    songlist: [{ songmid: "test-mid", songname: "夜航", singer: [{ name: "Sample artist" }], albumname: "夜" }], nick: "private creator detail" }] }
    : { code: 200, result: { id: 1234, name: "Selected NetEase playlist", trackCount: 3, privacy: 0,
      tracks: [{ id: 42, name: "夜航", artists: [{ name: "Sample artist" }], album: { name: "夜" }, playedNum: 999 }], creator: { nickname: "private creator detail" } } };
}

test("QQ and NetEase share links preview partial coverage and add distinct collection sources without plays", async (t) => {
  const { store, prepare } = await fixture(t);
  for (const [provider, link] of [["qq_music", "https://y.qq.com/n/ryqq/playlist/1234"], ["netease", "分享歌单 https://music.163.com/#/playlist?id=1234 (@网易云音乐)"]]) {
    const requests = [];
    const fetchImpl = async (url, options) => { requests.push({ url, options }); return Response.json(playlistData(provider === "qq_music")); };
    const prepared = await prepare(link, { fetchImpl, provider });
    assert.equal(prepared.preview.totalTracks, 3);
    assert.equal(prepared.preview.availableTracks, 1);
    assert.equal(prepared.preview.kind, "collection");
    assert.equal(prepared.preview.listeningEvents, 0);
    assert.equal(JSON.stringify(prepared).includes("private creator detail"), false);
    assert.equal(requests[0].options.redirect, "manual");
    assert.equal(requests[0].options.headers.Cookie, undefined);
    assert.equal(store.ingestImport(prepared.bundle).inserted_profile_evidence, 1);
    assert.equal(store.ingestImport(prepared.bundle).already_imported, true);
  }
  const profile = createListeningHistoryProfileProjection(store.profileSummary({ subjectId }));
  assert.equal(profile.coverage.collection_tracks, 2);
  assert.equal(profile.coverage.effective_listening_events, 0);
  assert.equal(profile.coverage.spotify_playlist_memberships, 0);
  assert.equal(profile.coverage.playlist_memberships, 2);
  assert.deepEqual(profile.curated_preferences.playlist_anchors.map((item) => item.source_label).sort(), ["NetEase Cloud Music", "QQ Music"]);
});

test("official short links resolve with a strict boundary, private and malformed responses do not import", async (t) => {
  const { prepare } = await fixture(t);
  let calls = 0;
  const fetchImpl = async () => ++calls === 1 ? new Response(null, { status: 302, headers: { location: "https://music.163.com/playlist?id=1234" } }) : Response.json(playlistData());
  assert.equal((await prepare("https://163cn.tv/example", { fetchImpl })).preview.tracks, 1);
  assert.equal(calls, 2);
  const redirect = async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
  await assert.rejects(prepare("https://163cn.tv/example", { fetchImpl: redirect }), /official share/u);
  await assert.rejects(prepare("https://evil.example/playlist?id=1234", { fetchImpl: () => assert.fail("must not fetch") }), /official share/u);
  await assert.rejects(prepare("https://music.163.com/playlist?id=1234", { provider: "qq_music", fetchImpl: () => assert.fail("must not fetch") }), /another service/u);
  const privateData = playlistData(); privateData.result.privacy = 10;
  await assert.rejects(prepare("https://music.163.com/playlist?id=1234", { fetchImpl: async () => Response.json(privateData) }), /unavailable publicly/u);
});
