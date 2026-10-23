import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createNeteaseLibrary, normalizeNeteaseCookie } from "../../src/integrations/netease/library.mjs";
import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";
import { runNeteaseCommand } from "../../src/surfaces/cli/netease-command.mjs";

const cookie = "MUSIC_U=fictional-test-session";
const account = { code: 200, account: { id: 12345 }, profile: { userId: 12345, nickname: "Fictional listener" } };
const song = (id) => ({ id, name: `Song ${id}`, ar: [{ name: "Example artist" }], al: { name: "Example album" }, dt: 180_000 });
const response = (data) => Response.json(data);
async function fixture(t, handler = () => response(account)) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-netease-test-"));
  const closers = [];
  t.after(async () => { for (const close of closers) await close(); await rm(root, { recursive: true, force: true }); });
  const calls = [];
  const options = { credentialPath: path.join(root, "session.json"), fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options });
    assert.equal(new URL(url).origin, "https://music.163.com");
    assert.equal(options.redirect, "error");
    return handler(new URL(url), options);
  } };
  const library = createNeteaseLibrary(options);
  return { root, options, calls, library, closers, signIn: () => library.login(async () => cookie) };
}

test("NetEase validates login, keeps credentials private, restores a session and logs out", async (t) => {
  const { library, signIn, options } = await fixture(t);
  assert.equal((await library.status()).state, "signed_out");
  const result = await signIn();
  assert.equal(result.account.nickname, "Fictional listener");
  assert.equal(JSON.stringify(result).includes("fictional-test-session"), false);
  assert.equal((await createNeteaseLibrary(options).status()).state, "connected");
  await library.logout();
  await assert.rejects(readFile(options.credentialPath), { code: "ENOENT" });
  assert.equal((await library.status()).state, "signed_out");
});

test("NetEase empty libraries are valid and every playlist page is read and deduplicated", async (t) => {
  let empty = true;
  const { library, signIn } = await fixture(t, (url) => {
    if (url.pathname.includes("account")) return response(account);
    const offset = Number(url.searchParams.get("offset"));
    const item = (id, creator) => ({ id, name: `Playlist ${id}`, creator: { userId: creator }, trackCount: 1 });
    return response({ code: 200, playlist: empty ? [] : offset === 0 ? [item(1001, 12345)] : [item(1001, 12345), item(1002, 9999)], more: !empty && offset === 0 });
  });
  await signIn();
  assert.deepEqual(await library.playlists(), []);
  empty = false;
  assert.deepEqual((await library.playlists()).map((item) => [item.id, item.kind]), [["1001", "created"], ["1002", "saved"]]);
});

test("NetEase completes a 1,204 track playlist in bounded batches and preserves order and unavailable entries", async (t) => {
  const { library, signIn, calls } = await fixture(t, (url, options) => {
    if (url.pathname.includes("account")) return response(account);
    if (url.pathname.includes("playlist/detail")) return response({ code: 200, playlist: { id: 1001, name: "Large fictional playlist",
      trackIds: Array.from({ length: 1204 }, (_, i) => ({ id: i + 1 })), tracks: [song(3), song(1)] } });
    const ids = JSON.parse(new URLSearchParams(options.body).get("c")).map((item) => Number(item.id));
    assert.ok(ids.length <= 200);
    return response({ code: 200, songs: ids.filter((id) => id !== 1204).reverse().map(song) });
  });
  await signIn();
  const result = await library.playlist("1001");
  assert.equal(result.tracks.length, 1204);
  assert.equal(result.tracks[2].title, "Song 3");
  assert.equal(result.tracks[1202].id, "1203");
  assert.equal(result.tracks[1203].available, false);
  assert.equal(calls.filter((call) => call.url.pathname.includes("song/detail")).length, 7);
});

test("NetEase imports the selected private playlist as idempotent collection evidence with no plays", async (t) => {
  const { root, library, signIn, closers } = await fixture(t, (url) => url.pathname.includes("account") ? response(account) : response({ code: 200,
    playlist: { id: 1001, privacy: 10, name: "Private fictional playlist", trackIds: [{ id: 1 }], tracks: [song(1)] } }));
  await signIn();
  const store = await openListeningHistoryStore({ environment: { MOONDOG_STATE_HOME: path.join(root, "history") } });
  closers.push(() => store.close());
  const subjectId = store.localSubjectId({ create: true });
  const prepared = await library.prepareImport("1001", { subjectId });
  assert.equal(prepared.bundle.listening_events.length, 0);
  assert.equal(prepared.bundle.profile_evidence[0].attributes.selected_account_playlist, true);
  assert.equal(prepared.bundle.profile_evidence[0].attributes.selected_public_playlist, false);
  assert.equal(JSON.stringify(prepared).includes("fictional-test-session"), false);
  assert.equal(store.ingestImport(prepared.bundle).inserted_profile_evidence, 1);
  assert.equal(store.ingestImport(prepared.bundle).already_imported, true);
});

test("NetEase rejects invalid identifiers and cookie/header injection before making a request", async (t) => {
  const { library, calls } = await fixture(t);
  for (const value of ["1&uid=2", "../1", "https://attacker.example", "", "0"]) await assert.rejects(library.playlist(value), { code: "netease_invalid_id" });
  assert.throws(() => normalizeNeteaseCookie("MUSIC_U=bad\r\nCookie: injected"));
  assert.throws(() => normalizeNeteaseCookie("other=value"));
  assert.equal(calls.length, 0);
});

test("NetEase session expiry forgets the local credential and failed login does not replace a good account", async (t) => {
  let expired = false;
  const { library, signIn, options } = await fixture(t, () => response(expired ? { code: 301 } : account));
  await signIn();
  await assert.rejects(library.login(async () => "invalid"), { code: "netease_invalid_cookie" });
  assert.equal((await library.status()).state, "connected");
  expired = true;
  assert.equal((await library.status({ refresh: true })).state, "signed_out");
  await assert.rejects(readFile(options.credentialPath), { code: "ENOENT" });
});

test("NetEase cancelling login preserves the existing account and logout invalidates late reads", async (t) => {
  let finish;
  const { library, signIn } = await fixture(t, (url) => url.pathname.includes("account") ? response(account) : new Promise((done) => { finish = done; }));
  await signIn();
  assert.equal((await library.login(async () => null)).cancelled, true);
  const pending = library.playlists();
  while (!finish) await new Promise(setImmediate);
  await library.logout();
  finish(response({ code: 200, playlist: [], more: false }));
  await assert.rejects(pending, { code: "netease_session_changed" });
});

test("NetEase CLI output lists collections without a cookie or untrusted terminal controls", async () => {
  const result = await runNeteaseCommand({ args: ["playlists"], library: { playlists: async () => [{ id: "1001", name: "Night\u001b[31m", kind: "created", trackCount: 3 }] } });
  assert.match(result.markdown, /1001/u);
  assert.equal(result.markdown.includes("\u001b"), false);
});

test("authenticated playback prefers a permitted full lower-quality source and never exposes its cookie", async (t) => {
  const { library, signIn } = await fixture(t, (url, options) => {
    if (url.pathname.includes("account")) return response(account);
    assert.equal(options.headers.Cookie, cookie);
    return response({ code: 200, data: [{ id: 1, code: 200, url: "http://m8.music.126.net/song.mp3", freeTrialInfo: url.searchParams.get("level") === "standard" ? null : { start: 0, end: 30 } }] });
  });
  await signIn();
  const source = await library.playback("1");
  assert.equal(source.url, "https://m8.music.126.net/song.mp3");
  assert.equal(source.trial, false);
  assert.equal(JSON.stringify(source).includes(cookie), false);
});

test("playback refuses unrelated media hosts and reports unplayable account rights", async (t) => {
  const { library, signIn } = await fixture(t, (url) => url.pathname.includes("account") ? response(account) : response({ code: 200,
    data: [{ id: 1, code: 200, url: "https://attacker.example/song.mp3" }] }));
  await signIn();
  await assert.rejects(library.playback("1"), { code: "netease_unplayable" });
});
