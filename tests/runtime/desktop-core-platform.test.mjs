import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { createFictionalSpotifyHistoryArchive } from "../../src/demo/fictional-spotify-history.mjs";
import { listZipMembers, readZipMember } from "../../src/importers/zip-reader.mjs";
import { prepareHistoryImport } from "../../src/profile/history-import.mjs";
import { readYouTubeMusicTakeout } from "../../src/integrations/youtube-music/takeout.mjs";
import { findNcmCli } from "../../src/integrations/netease/ncm-cli-player.mjs";
import { createMusicAppPlayer } from "../../src/integrations/apple-music/music-app.mjs";
import { PersistentCredentialStore } from "../../src/runtime/pi/persistent-credential-store.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";
const capturedAt = "2026-10-28T00:00:00.000Z";

async function folder(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "moondog desktop core "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// One compressed member, made without a system zip command so this test runs on Windows too.
function archive(name, text, checksum = crc32(Buffer.from(text))) {
  const filename = Buffer.from(name);
  const data = Buffer.from(text);
  const compressed = deflateRawSync(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  local.copy(central, 6, 4, 30);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + compressed.length, 16);
  return Buffer.concat([local, filename, compressed, central, filename, end]);
}

test("desktop previews a fictional Spotify ZIP through the import entrypoint with native paths, spaces and Unicode", async (t) => {
  const root = await folder(t);
  const archivePath = path.join(root, "音乐 history.zip");
  await writeFile(archivePath, createFictionalSpotifyHistoryArchive());
  // Exercise the same path normalization as a desktop drop and file picker, including Windows separators.
  for (const filePath of [archivePath, `"${archivePath}"`, `'${archivePath}'`, pathToFileURL(archivePath).href]) {
    const { provider, preview, bundle } = await prepareHistoryImport({ filePath, subjectId, capturedAt });
    assert.equal(provider, "spotify");
    assert.equal(preview.fileName, "音乐 history.zip");
    assert.equal(preview.source, "spotify-extended");
    assert.ok(preview.listeningEvents > 0);
    assert.ok(preview.tracks > 0);
    assert.equal(preview.listeningEvents, bundle.listening_events.length);
    assert.equal(bundle.import_batch.source_format, "spotify_extended_streaming_history_music_v1");
  }
});

test("ZIP reads compressed Unicode data and rejects excessive data, missing members and damaged checksums", async (t) => {
  const name = "Takeout/音乐/music-library-songs.csv";
  const data = "Video ID,Song Title,Album Title,Artist Name\nAbcdefgh_12,月亮,Sky,Example Artist\n";
  const bytes = archive(name, data);
  assert.deepEqual(await listZipMembers(bytes), [name]);
  assert.equal((await readZipMember(bytes, name, 1024)).toString("utf8"), data);
  await assert.rejects(readZipMember(bytes, name, 4), /exceeds/u);
  await assert.rejects(listZipMembers(bytes, 4), /exceeds/u);
  await assert.rejects(readZipMember(bytes, "missing", 1024), /not found/u);
  await assert.rejects(readZipMember(archive(name, data, 0), name, 1024), /checksum/u);
  await assert.rejects(listZipMembers(archive("../music-library-songs.csv", data)), /relative path/u);
  const root = await folder(t);
  const filePath = path.join(root, "takeout.zip");
  await writeFile(filePath, bytes);
  const prepared = await readYouTubeMusicTakeout({ filePath, subjectId, capturedAt });
  assert.equal(prepared.bundle.track_refs[0].title, "月亮");
  assert.equal(prepared.preview.profileEvidence, 1);
  // Early rejection must close the file too, so Windows can immediately remove it.
  await assert.rejects(readZipMember(filePath, name, 4), /exceeds/u);
  await rm(filePath);
});

test("desktop credential writes survive reload, replacement and removal on every platform", async (t) => {
  const root = await folder(t);
  const authFile = path.join(root, "config", "auth.json");
  const store = new PersistentCredentialStore({ authFile });
  await store.modify("openai", async () => ({ type: "api_key", key: "SYNTHETIC_KEY_ONE" }));
  const reloaded = new PersistentCredentialStore({ authFile });
  assert.equal((await reloaded.read("openai")).key, "SYNTHETIC_KEY_ONE");
  await reloaded.modify("openai", async () => ({ type: "api_key", key: "SYNTHETIC_KEY_TWO" }));
  assert.equal((await store.read("openai")).key, "SYNTHETIC_KEY_TWO");
  await reloaded.delete("openai");
  assert.equal(await store.read("openai"), undefined);
});

test("NetEase resolves npm's Windows entry without executing a command shell", async (t) => {
  const root = await folder(t);
  const packageRoot = path.join(root, "node_modules", "@music163", "ncm-cli");
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ bin: { "ncm-cli": "dist/index.js" } }));
  const entry = path.join(packageRoot, "dist", "index.js");
  await writeFile(entry, "// synthetic executable\n");
  const node = path.join(root, "node.exe");
  await writeFile(node, "synthetic node");
  await chmod(node, 0o755);
  const result = await findNcmCli({ Path: root }, "win32");
  assert.equal(result.file, node);
  assert.deepEqual(result.args, [entry]);
  assert.deepEqual(result.places, [root]);
  assert.equal(await findNcmCli({ Path: path.join(root, "missing") }, "win32"), null);
});

test("disposable desktop checks can disable all system Music reads and controls", async () => {
  let calls = 0;
  const run = async () => { calls += 1; return '{"state":"stopped"}'; };
  const isolated = createMusicAppPlayer({ platform: "darwin", environment: { MOONDOG_SYSTEM_MUSIC: "off" }, run });
  assert.equal(isolated.available, false);
  for (const action of ["nowPlaying", "pause", "resume", "next", "previous", "seek"]) {
    assert.deepEqual(await isolated[action](), { state: "unavailable" });
  }
  assert.equal(await isolated.cover({ id: "synthetic-song" }), null);
  assert.equal(calls, 0);
  const normal = createMusicAppPlayer({ platform: "darwin", environment: {}, run });
  assert.equal(normal.available, true);
  await normal.nowPlaying();
  assert.equal(calls, 1);
});
