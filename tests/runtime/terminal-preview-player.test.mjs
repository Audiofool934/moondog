import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createTerminalPreviewPlayer, findSystemPlayer } from "../../src/integrations/apple-music/terminal-preview-player.mjs";

async function until(predicate, message = "the player did not reach the expected state") {
  const deadline = performance.now() + 5000;
  while (!(await predicate())) {
    assert.ok(performance.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// A silent stand-in for the system's player. It logs its process ID, its argument
// count, and the bytes of the file it was given, then waits as long as a song lasts.
async function silentPlayers(t, names, { seconds = 0 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-preview-player-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const temporaryRoot = path.join(root, "tmp");
  const log = path.join(root, "played.log");
  await mkdir(bin);
  await mkdir(temporaryRoot);
  for (const name of names) {
    const script = path.join(bin, name);
    await writeFile(script, `#!/bin/sh\nfor last; do :; done\nprintf '%s|%s|%s\\n' "$$" "$#" "$(cat "$last")" >> "${log}"\nexec sleep ${seconds}\n`);
    await chmod(script, 0o755);
  }
  const played = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => {
    const [pid, count, bytes] = line.split("|");
    return { pid: Number(pid), args: Number(count), bytes };
  });
  return { bin, temporaryRoot, played, environment: { PATH: bin } };
}

const preview = (name) => `https://audio-ssl.itunes.apple.com/itunes-assets/${name}.m4a`;
const song = (name, overrides = {}) => ({
  title: `Song ${name}`,
  artist_credit: "Fixture Artist",
  preview_url: preview(name),
  catalog_url: `https://music.apple.com/us/album/fixture/1?i=${name}`,
  artwork_url: "https://is1-ssl.mzstatic.com/image/cover/300x300bb.jpg",
  ...overrides,
});

function fakeApple() {
  const fetched = [];
  const fetchImpl = async (url, { signal } = {}) => {
    fetched.push(url);
    signal?.throwIfAborted();
    const name = /\/(\w+)\.m4a$/u.exec(url)?.[1];
    // "slow" never arrives; only an abort ends it.
    if (name === "slow") return await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    return name === "missing" ? new Response("", { status: 404 }) : new Response(`audio of ${name}`);
  };
  return { fetched, fetchImpl };
}

function record(player) {
  const events = [];
  player.subscribe((event) => events.push(event));
  return events;
}
const summary = (events) => events.map((event) => event.type === "playing" ? `${event.position}/${event.count} ${event.track.title}`
  : event.type === "loading" ? `loading ${event.position}/${event.count} ${event.track.title}` : event.type);

test("the room finds a system player on PATH, or none", async (t) => {
  const { bin, environment } = await silentPlayers(t, ["afplay", "ffplay", "mpv"]);
  assert.deepEqual(await findSystemPlayer({ platform: "darwin", environment }), { command: path.join(bin, "afplay"), args: [] });
  assert.deepEqual(await findSystemPlayer({ platform: "linux", environment }), { command: path.join(bin, "ffplay"), args: ["-nodisp", "-autoexit", "-loglevel", "quiet"] });
  const onlyMpv = await silentPlayers(t, ["mpv"]);
  assert.deepEqual(await findSystemPlayer({ platform: "linux", environment: onlyMpv.environment }), { command: path.join(onlyMpv.bin, "mpv"), args: ["--no-video", "--no-terminal"] });
  // Relative PATH entries never count: a folder you happen to be in can't supply a player.
  assert.equal(await findSystemPlayer({ platform: "linux", environment: { PATH: `.${path.delimiter}bin` } }), null);
  assert.equal(await findSystemPlayer({ platform: "win32", environment }), null);
  assert.equal(await createTerminalPreviewPlayer({ platform: "linux", environment: { PATH: path.join(bin, "none") } }), null);
});

test("previews play one after another from temporary files, each next to its Apple Music link", async (t) => {
  const players = await silentPlayers(t, ["afplay"]);
  const apple = fakeApple();
  const player = await createTerminalPreviewPlayer({ platform: "darwin", environment: players.environment, fetchImpl: apple.fetchImpl, temporaryRoot: players.temporaryRoot });
  t.after(() => player.close());
  const events = record(player);
  player.play([
    song("one"),
    song("web", { preview_url: "https://example.com/web.m4a" }),
    song("store", { catalog_url: "https://example.com/store" }),
    song("missing"),
    song("two"),
  ], { album: { title: "Fixture Album", artist_credit: "Fixture Artist", catalog_url: "https://music.apple.com/us/album/fixture/1" } });
  await until(() => events.at(-1)?.type === "stopped");

  assert.deepEqual(events[0], {
    type: "queue",
    tracks: ["one", "missing", "two"].map((name) => ({ title: `Song ${name}`, artist_credit: "Fixture Artist", catalog_url: `https://music.apple.com/us/album/fixture/1?i=${name}` })),
    album: { title: "Fixture Album", artist_credit: "Fixture Artist", catalog_url: "https://music.apple.com/us/album/fixture/1" },
  }, "only https previews from Apple's audio host, with links on music.apple.com, join the queue");
  assert.deepEqual(summary(events.slice(1)),
    ["loading 1/3 Song one", "1/3 Song one", "loading 3/3 Song two", "3/3 Song two", "stopped"], "a preview that fails to download is passed over");
  assert.deepEqual(apple.fetched, [preview("one"), preview("missing"), preview("two")]);
  assert.deepEqual((await players.played()).map(({ args, bytes }) => `${args} ${bytes}`), ["1 audio of one", "1 audio of two"]);
  const [folder] = await readdir(players.temporaryRoot);
  assert.match(folder, /^moondog-previews-/u);
  assert.deepEqual(await readdir(path.join(players.temporaryRoot, folder)), [], "each file goes once it has played");
  player.close();
  assert.deepEqual(await readdir(players.temporaryRoot), []);
});

test("a new queue replaces the one playing; skip, stop, and close end the sound at once", async (t) => {
  const players = await silentPlayers(t, ["ffplay"], { seconds: 30 });
  const apple = fakeApple();
  const player = await createTerminalPreviewPlayer({ platform: "linux", environment: players.environment, fetchImpl: apple.fetchImpl, temporaryRoot: players.temporaryRoot });
  t.after(() => player.close());
  const events = record(player);
  assert.equal(player.stop(), false, "nothing is playing yet");
  assert.equal(player.skip(), false);

  player.play([song("one"), song("two")]);
  await until(async () => (await players.played()).length === 1);
  const [first] = await players.played();
  assert.equal(first.args, 5, "ffplay gets its quiet, windowless flags before the file");

  player.play([song("three"), song("four")]);
  await until(async () => (await players.played()).length === 2 && !alive(first.pid), "the replaced preview kept playing");
  assert.equal((await players.played())[1].bytes, "audio of three");
  assert.deepEqual(summary(events),
    ["queue", "loading 1/2 Song one", "1/2 Song one", "stopped", "queue", "loading 1/2 Song three", "1/2 Song three"]);

  assert.equal(player.skip(), true);
  await until(async () => (await players.played()).length === 3);
  assert.equal((await players.played())[2].bytes, "audio of four");

  assert.equal(player.stop(), true);
  const fourth = (await players.played())[2];
  await until(() => !alive(fourth.pid), "stop left the preview playing");
  assert.equal(events.at(-1).type, "stopped");

  player.play([song("five")]);
  await until(async () => (await players.played()).length === 4);
  const fifth = (await players.played())[3];
  player.close();
  await until(() => !alive(fifth.pid), "close left the preview playing");
  assert.deepEqual(await readdir(players.temporaryRoot), [], "close removes the temporary files");
  player.play([song("six")]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await players.played()).length, 4, "a closed player plays nothing");
});

test("skip while a preview is still loading moves on to the next song", async (t) => {
  const players = await silentPlayers(t, ["afplay"]);
  const apple = fakeApple();
  const player = await createTerminalPreviewPlayer({ platform: "darwin", environment: players.environment, fetchImpl: apple.fetchImpl, temporaryRoot: players.temporaryRoot });
  t.after(() => player.close());
  const events = record(player);
  player.play([song("slow"), song("two")]);
  assert.deepEqual(summary(events), ["queue", "loading 1/2 Song slow"]);
  assert.equal(player.skip(), true);
  await until(() => events.at(-1)?.type === "stopped");
  assert.deepEqual(summary(events), ["queue", "loading 1/2 Song slow", "loading 2/2 Song two", "2/2 Song two", "stopped"]);
  assert.deepEqual((await players.played()).map(({ bytes }) => bytes), ["audio of two"]);
});
