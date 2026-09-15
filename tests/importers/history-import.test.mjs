import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { createFictionalSpotifyHistoryArchive } from "../../src/demo/fictional-spotify-history.mjs";
import { prepareHistoryImport } from "../../src/profile/history-import.mjs";

const exec = promisify(execFile);
const subjectId = "11111111-1111-4111-8111-111111111111";
const capturedAt = "2026-09-15T00:00:00.000Z";
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-prepare-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const zip = path.join(root, "My history.zip");
  await writeFile(zip, createFictionalSpotifyHistoryArchive());
  return { root, zip };
}
const prepare = (filePath) => prepareHistoryImport({ filePath, subjectId, capturedAt });

test("Spotify preparation describes the retained bundle and leaves source/state untouched", async (t) => {
  const { root, zip } = await fixture(t);
  const before = await readFile(zip);
  const files = await readdir(root);
  const prepared = await prepare(zip);
  assert.equal(prepared.provider, "spotify");
  assert.equal(prepared.preview.sourceLabel, "Spotify Extended Streaming History");
  assert.equal(prepared.preview.fileName, "My history.zip");
  assert.equal(prepared.preview.listeningEvents, 52);
  assert.equal(prepared.preview.eventsWithPlayedMs, 52);
  assert.equal(prepared.preview.profileEvidence, 0);
  assert.equal(prepared.preview.tracks, prepared.bundle.track_refs.length);
  assert.match(prepared.preview.earliestListeningAt, /^2023/u);
  assert.match(prepared.preview.latestListeningAt, /^2026/u);
  assert.equal(JSON.stringify(prepared.preview).includes(subjectId), false);
  assert.equal(JSON.stringify(prepared.preview).includes(root), false);
  assert.deepEqual(await readFile(zip), before);
  assert.deepEqual(await readdir(root), files);
});

test("literal pasted, quoted, escaped, relative, home and local URL paths identify the same file", async (t) => {
  const { root, zip } = await fixture(t);
  const forms = [zip, `  ${zip}  `, `'${zip}'`, `"${zip}"`, zip.replaceAll(" ", "\\ "), path.relative(process.cwd(), zip), `~/${path.relative(homedir(), zip)}`, pathToFileURL(zip).href, pathToFileURL(zip).href.replace("file:///", "file://localhost/")];
  const ids = [];
  for (const value of forms) ids.push((await prepare(value)).bundle.import_batch.import_batch_id);
  assert.equal(new Set(ids).size, 1);
  for (const value of [`'${zip}`, `'${zip}' '${zip}'`, `${zip}\n${zip}`, "file://elsewhere/history.zip", `${pathToFileURL(zip)}?download=1`]) {
    await assert.rejects(prepare(value), { code: "history_import_path_invalid" });
  }
  for (const value of ["$(pwd)/history.zip", "$HOME/history.zip"]) {
    await assert.rejects(prepare(value), { code: "history_import_file_missing" });
  }
  assert.deepEqual((await readdir(root)).sort(), ["My history.zip"]);
});

test("dollar signs, backticks and substitution-looking filenames remain literal", async (t) => {
  const { root, zip } = await fixture(t);
  const fileName = "Ke$ha `literal` $(pwd).zip";
  const special = path.join(root, fileName);
  await writeFile(special, await readFile(zip));
  const escaped = special.replaceAll(" ", "\\ ").replaceAll("$", "\\$").replaceAll("`", "\\`");
  for (const value of [special, `'${special}'`, `"${special}"`, escaped]) {
    const result = await prepare(value);
    assert.equal(result.preview.fileName, fileName);
    assert.equal(result.preview.listeningEvents, 52);
  }
  assert.deepEqual((await readdir(root)).sort(), [fileName, "My history.zip"].sort());
});

test("ListenBrainz preview preserves unknown actual durations and rejects raw Spotify JSON", async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, "listens.json");
  await writeFile(file, JSON.stringify({ listen_type: "import", payload: [
    { listened_at: 1704103200, track_metadata: { artist_name: "Example Artist", track_name: "Unknown duration", additional_info: { duration_ms: 200000 } } },
    { listened_at: 1735725600, track_metadata: { artist_name: "Example Artist", track_name: "Measured", additional_info: { duration_played: 120 } } },
  ] }));
  const result = await prepare(file);
  assert.equal(result.provider, "listenbrainz");
  assert.equal(result.preview.listeningEvents, 2);
  assert.equal(result.preview.eventsWithPlayedMs, 1);
  assert.equal(result.preview.tracks, 2);
  await writeFile(file, JSON.stringify([{ endTime: "2026-01-01 12:00", artistName: "Example", trackName: "Song", msPlayed: 1000 }]));
  await assert.rejects(prepare(file), /ListenBrainz.*Spotify.*original ZIP/iu);
  await writeFile(file, "{");
  await assert.rejects(prepare(file), /invalid JSON/iu);
});

test("Spotify Account Data distinguishes listening dates from saved-library evidence", async (t) => {
  const { root } = await fixture(t);
  const folder = path.join(root, "Spotify Account Data");
  await mkdir(folder);
  await writeFile(path.join(folder, "StreamingHistory_music_0.json"), JSON.stringify([
    { endTime: "2025-10-01 12:00", artistName: "Example Artist", trackName: "History song", msPlayed: 123000 },
  ]));
  await writeFile(path.join(folder, "YourLibrary.json"), JSON.stringify({
    tracks: [{ track: "Saved song", artist: "Example Artist", album: "Example album", uri: "spotify:track:1111111111111111111111" }],
    albums: [],
    artists: [],
  }));
  const zip = path.join(root, "account.zip");
  await exec("/usr/bin/zip", ["-q", "-r", zip, "Spotify Account Data"], { cwd: root });
  const result = await prepare(zip);
  assert.equal(result.preview.sourceLabel, "Spotify Account Data");
  assert.equal(result.preview.dataScope, "past_year_account_data");
  assert.equal(result.preview.listeningEvents, 1);
  assert.equal(result.preview.eventsWithPlayedMs, 1);
  assert.equal(Array.isArray(result.bundle.profile_evidence), true);
  assert.equal(result.bundle.profile_evidence.length, 1);
  assert.equal(result.preview.profileEvidence, 1);
  assert.equal(result.preview.tracks, 2);
  assert.equal(result.preview.earliestListeningAt, "2025-10-01T12:00:00.000Z");
  assert.equal(result.preview.latestListeningAt, "2025-10-01T12:00:00.000Z");
  assert.match(result.preview.scopeNote, /profile snapshots/u);
});

test("missing paths, folders, Apple snapshots, unsupported files and ambiguous archives explain the boundary", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(prepare(path.join(root, "missing.zip")), { code: "history_import_file_missing" });
  await assert.rejects(prepare(root), /original Spotify ZIP/u);
  for (const extension of ["xml", "csv"]) {
    const file = path.join(root, `history.${extension}`);
    await writeFile(file, "example");
    await assert.rejects(prepare(file), extension === "xml" ? /import:apple-library/u : /not supported/u);
  }
  const invalid = path.join(root, "invalid.zip");
  await writeFile(invalid, "not a ZIP");
  await assert.rejects(prepare(invalid), /ZIP.*read/iu);
  for (const [folder, member] of [["Spotify Account Data", "StreamingHistory_music_0.json"], ["Spotify Extended Streaming History", "Streaming_History_Audio_2026.json"]]) {
    await mkdir(path.join(root, folder));
    await writeFile(path.join(root, folder, member), "[]");
  }
  const ambiguous = path.join(root, "ambiguous.zip");
  await exec("/usr/bin/zip", ["-q", "-r", ambiguous, "Spotify Account Data", "Spotify Extended Streaming History"], { cwd: root });
  await assert.rejects(prepare(ambiguous), /one unambiguous Spotify history format/u);
});
