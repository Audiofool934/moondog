import assert from "node:assert/strict";
import test from "node:test";

import { createNeteasePlayer } from "../../src/integrations/netease/ncm-cli-player.mjs";

const record = (id, name, artist, visible, seconds = 198) => ({
  id, originalId: Number.parseInt(id.slice(0, 6), 16), name, artists: [{ name: artist }], album: { name: `${name} album` },
  duration: seconds * 1000, coverImgUrl: "http://p1.music.126.net/cover.jpg", visible,
});
const SONGS = [
  record("1D71F87C34BD42F6F13574EB6AFA8516", "稻香", "Jay", true),
  record("81804C7DB01B6A0CB44E9AE685E829AA", "稻香", "周杰伦", false),
  record("FC9E6A32E6C9F52C40D07E85B076B329", "稻香(治愈版)", "街道办GDC", true, 121),
];
const byId = new Map(SONGS.map((song) => [song.id, song]));

// A stand-in ncm-cli whose player behaves like the real one: play loads the song one state read
// later, seek moves it, a paused song reads as stopped with its title, and a song stops at its end.
function fakeCli({ search = SONGS } = {}) {
  const calls = [];
  const player = { song: null, status: "stopped", position: 0, loading: 0 };
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "search") return { code: 200, data: { records: search } };
    if (args[0] === "login") return { success: true, message: "已登录实名账号" };
    if (args[0] === "play") { Object.assign(player, { song: byId.get(args[3]), status: "stopped", position: 0, loading: 1 }); return {}; }
    if (args[0] === "pause") player.status = "stopped";
    if (args[0] === "resume") player.status = "playing";
    if (args[0] === "seek") player.position = Number(args[1]);
    if (args[0] === "stop") Object.assign(player, { song: null, status: "stopped", position: 0 });
    if (args[0] === "state") {
      if (player.loading && !--player.loading) player.status = "playing";
      if (!player.song) return { success: true, state: { status: "stopped", position: 0, currentIndex: 0, queueLength: 0 } };
      if (player.status === "playing" && player.position >= player.song.duration / 1000) player.status = "stopped";
      return { success: true, state: { status: player.status, title: `${player.song.name} - ${player.song.artists[0].name}`, position: player.position,
        duration: player.song.duration / 1000, currentIndex: 0, queueLength: 0 } };
    }
    return { success: true };
  };
  return { run, calls, player };
}
const plays = (calls) => calls.filter((args) => args[0] === "play").map((args) => args[3]);

test("search keeps NetEase's playable mark, serves covers over https and sends only a short intent", async () => {
  const { run, calls } = fakeCli();
  const player = createNeteasePlayer({ run, wait: async () => {} });
  const songs = await player.search({ query: "稻香", limit: 3, intent: "  听 一首\n稻香  " });
  assert.deepEqual(songs.map((song) => song.playable), [true, false, true]);
  assert.equal(songs[0].image, "https://p1.music.126.net/cover.jpg");
  assert.deepEqual(calls[0], ["search", "song", "--keyword", "稻香", "--limit", "3", "--userInput", "听 一首 稻香"]);
});

test("play picks the exact title by another artist over a longer title, and never sends an unplayable one", async () => {
  const { run, calls } = fakeCli();
  const player = createNeteasePlayer({ run, wait: async () => {} });
  const result = await player.play({ items: [{ title: "稻香", artist: "周杰伦" }, { title: "Bohemian Rhapsody", artist: "Queen" }], intent: "播放稻香" });
  assert.equal(result.mode, "playing");
  assert.deepEqual(result.songs.map((song) => [song.title, song.other_artist]), [["稻香", true]]);
  assert.deepEqual(result.not_found, [{ title: "Bohemian Rhapsody", artist: "Queen" }]);
  assert.ok(!calls.some((args) => args.includes("81804C7DB01B6A0CB44E9AE685E829AA")));
  player.stop();
});

test("Moondog keeps the queue: one song plays, next plays the following one, previous goes back", async () => {
  const { run, calls, player: fake } = fakeCli();
  const player = createNeteasePlayer({ run, wait: async () => {} });
  const songs = await player.search({ query: "稻香" });
  await player.play({ items: [{ id: songs[0].id }, { id: songs[2].id }] });
  assert.deepEqual(plays(calls), [songs[0].id], "only the first song goes to the player");
  assert.ok(!calls.some((args) => args[0] === "queue"), "ncm-cli's own queue is never used");
  assert.deepEqual((await player.nowPlaying()).next.map((song) => song.title), ["稻香(治愈版)"]);
  await player.next();
  assert.equal((await player.nowPlaying()).song.title, "稻香(治愈版)");
  await assert.rejects(player.next(), /Nothing is queued after this song/u);
  fake.position = 1;
  await player.previous();
  assert.equal((await player.nowPlaying()).song.title, "稻香", "early in a song, previous goes to the one before");
  fake.position = 40;
  await player.previous();
  assert.equal(fake.position, 0, "later in a song, previous starts it again");
  await player.stop();
});

test("a queue request adds after the song playing, and plays when nothing is loaded", async () => {
  const { run, calls } = fakeCli();
  const player = createNeteasePlayer({ run, wait: async () => {} });
  const songs = await player.search({ query: "稻香" });
  assert.equal((await player.play({ items: [{ id: songs[0].id }], mode: "queue" })).mode, "playing");
  assert.equal((await player.play({ items: [{ id: songs[2].id }], mode: "queue" })).mode, "queued");
  assert.deepEqual(plays(calls), [songs[0].id]);
  assert.deepEqual((await player.nowPlaying()).next.map((song) => song.title), ["稻香(治愈版)"]);
  await player.stop();
});

test("when a song ends, the next queued one starts", async () => {
  const { run, calls, player: fake } = fakeCli();
  const player = createNeteasePlayer({ run, wait: async () => {}, keepAliveMs: 5 });
  const songs = await player.search({ query: "稻香" });
  await player.play({ items: [{ id: songs[0].id }, { id: songs[2].id }] });
  fake.position = 197;
  await new Promise((done) => setTimeout(done, 20));
  fake.position = 198;
  for (const deadline = Date.now() + 2000; plays(calls).length < 2;) {
    assert.ok(Date.now() < deadline, "the next song did not start");
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.equal(plays(calls)[1], songs[2].id);
  await player.stop();
});

test("a paused song reads as paused, with its position in milliseconds", async () => {
  const { run, player: fake } = fakeCli();
  const player = createNeteasePlayer({ run, wait: async () => {} });
  const songs = await player.search({ query: "稻香" });
  await player.play({ items: [{ id: songs[0].id }] });
  fake.position = 61.25;
  await player.pause();
  const paused = await player.nowPlaying();
  assert.equal(paused.state, "paused");
  assert.equal(paused.position_ms, 61_250);
  assert.equal(paused.song.duration_ms, 198_000);
  await player.stop();
  assert.equal((await player.nowPlaying()).state, "stopped");
});

test("an unplayable search result is reported, not played", async () => {
  const { run, calls } = fakeCli();
  const player = createNeteasePlayer({ run, wait: async () => {} });
  await player.search({ query: "稻香" });
  const result = await player.play({ items: [{ id: "81804C7DB01B6A0CB44E9AE685E829AA" }] });
  assert.equal(result.mode, "none");
  assert.equal(result.unplayable.length, 1);
  assert.deepEqual(plays(calls), []);
});

test("NetEase's own refusals become plain errors", async () => {
  const limited = createNeteasePlayer({ run: async () => ({ code: 429, message: "请求总量超限" }) });
  await assert.rejects(limited.search({ query: "稻香" }), { code: "netease_rate_limited" });
  const signedOut = createNeteasePlayer({ run: async () => ({ success: false, message: "未登录" }) });
  assert.equal((await signedOut.check()).state, "signed_out");
  assert.equal(signedOut.ready(), false);
});

test("ncm-cli commands never overlap, because two at once corrupt its files", async () => {
  let active = 0;
  let most = 0;
  const run = async (args) => {
    active += 1;
    most = Math.max(most, active);
    await new Promise((done) => setTimeout(done, 5));
    active -= 1;
    return args[0] === "search" ? { code: 200, data: { records: SONGS } } : { success: true, state: { status: "playing", title: "稻香 - Jay", currentIndex: 0 } };
  };
  const player = createNeteasePlayer({ run, wait: async () => {} });
  await Promise.all([player.search({ query: "稻香" }), player.nowPlaying(), player.pause(), player.nowPlaying()]);
  assert.equal(most, 1);
});
