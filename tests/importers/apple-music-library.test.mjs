import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { canonicalizeJson } from "../../scripts/contract-semantics.mjs";
import {
  AppleMusicImportError,
  inspectAppleMusicLibraryFile,
  normalizeAppleMusicLibrary,
  parseAppleMusicLibraryBuffer,
  writeAppleMusicImportBatch,
} from "../../src/importers/apple-music-library/index.mjs";

const fixturePath = fileURLToPath(
  new URL("../fixtures/apple-music-library/minimal.xml", import.meta.url),
);
const fixtureBuffer = await readFile(fixturePath);
const fixtureXml = fixtureBuffer.toString("utf8");
const subjectId = "11111111-2222-4333-8444-555555555555";
const execFile = promisify(execFileCallback);
const cliPath = fileURLToPath(
  new URL("../../scripts/import-apple-music-library.mjs", import.meta.url),
);

function parsedFixture() {
  return parseAppleMusicLibraryBuffer(Buffer.from(fixtureBuffer));
}

async function normalizedFixture() {
  return normalizeAppleMusicLibrary(parsedFixture(), { subjectId });
}

function assertImportError(error, code) {
  return error instanceof AppleMusicImportError && error.code === code;
}

test("inspect returns only aggregate, non-writing information", async () => {
  const result = await inspectAppleMusicLibraryFile(fixturePath);

  assert.equal(result.ok, true);
  assert.equal(result.writes_performed, false);
  assert.deepEqual(result.counts, {
    tracks: 3,
    playlists: 1,
    playlist_item_references: 2,
    provisional_track_candidates: 3,
    aggregate_track_snapshots: 3,
    core_listening_events: 0,
    core_taste_events: 0,
  });
  assert.equal(result.coverage.aggregate_play_count, 1);
  assert.equal(result.coverage.last_played_at, 1);
  assert.equal(result.coverage.local_file_reference, 1);

  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "Synthetic Alpha",
    "Example Artist",
    "Private Synthetic Playlist",
    "AAAABBBBCCCCDDDD",
    "file:///Users/synthetic/private/",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("normalization creates provisional TrackRefs and aggregate snapshots only", async () => {
  const records = await normalizedFixture();

  assert.equal(records.trackRefs.length, 3);
  assert.equal(records.trackSnapshots.length, 3);
  assert.equal(records.manifest.counts.core_listening_events, 0);
  assert.equal(records.manifest.counts.core_taste_events, 0);
  assert.equal(
    records.manifest.semantics.aggregate_counts_expanded_into_events,
    false,
  );
  assert.equal(
    records.manifest.semantics.explicit_states_projected_into_taste_events,
    false,
  );
  assert.ok(
    records.trackRefs.every(
      (trackRef) =>
        trackRef.identity_status === "provisional" && trackRef.revision === 1,
    ),
  );

  const richTrack = records.trackRefs.find(
    (trackRef) => trackRef.extensions?.["apple_music.genre"],
  );
  assert.ok(richTrack);
  assert.equal(richTrack.duration_ms, 123000);
  assert.equal(richTrack.release.release_date, "2024-01-02");
  assert.equal(richTrack.extensions["apple_music.composer"], "Example Composer");

  const richSnapshot = records.trackSnapshots.find(
    (snapshot) => snapshot.track_ref_id === richTrack.track_ref_id,
  );
  assert.deepEqual(richSnapshot.aggregate_state, {
    play_count: 99,
    last_played_at: "2026-08-20T12:00:00.000Z",
    skip_count: 3,
    last_skipped_at: "2026-08-21T12:00:00.000Z",
    rating: { value: 80, computed: true },
    album_rating: { value: 60 },
    loved: true,
    favorited: true,
  });

  const fallbackTrack = records.trackRefs.find(
    (trackRef) => trackRef.title === "No Stable ID",
  );
  assert.equal(fallbackTrack.artist_credits[0].name, "Fallback Ensemble");
  assert.ok(
    records.warnings.some(
      (warning) => warning.code === "identity_fallback_unstable",
    ),
  );
  assert.ok(
    records.warnings.some(
      (warning) => warning.code === "artist_fell_back_to_album_artist",
    ),
  );
  assert.ok(
    records.warnings.some(
      (warning) => warning.code === "legacy_play_date_not_projected",
    ),
  );
});

test("normalization excludes raw provider IDs, paths, comments, and grouping", async () => {
  const serialized = canonicalizeJson(await normalizedFixture());

  for (const forbidden of [
    "AAAABBBBCCCCDDDD",
    "1111222233334444",
    "5555666677778888",
    "99990000AAAABBBB",
    "file:///Users/synthetic/private/",
    "file:///Users/synthetic/private/alpha.m4a",
    "PRIVATE_COMMENT_SENTINEL",
    "PRIVATE_GROUPING_SENTINEL",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("cross-batch identity stays stable without reusing immutable TrackRef revisions", async () => {
  const firstParsed = parsedFixture();
  const secondParsed = parsedFixture();
  secondParsed.sourceSha256 = "f".repeat(64);

  const first = await normalizeAppleMusicLibrary(firstParsed, { subjectId });
  const repeat = await normalizeAppleMusicLibrary(parsedFixture(), { subjectId });
  const second = await normalizeAppleMusicLibrary(secondParsed, { subjectId });

  assert.equal(canonicalizeJson(first), canonicalizeJson(repeat));
  assert.notEqual(first.manifest.import_batch_id, second.manifest.import_batch_id);

  for (const title of ["Synthetic Alpha"]) {
    const firstTracks = first.trackRefs
      .filter((record) => record.title === title)
      .sort((left, right) =>
        left.external_refs[0].external_id.localeCompare(
          right.external_refs[0].external_id,
        ),
      );
    const secondTracks = second.trackRefs
      .filter((record) => record.title === title)
      .sort((left, right) =>
        left.external_refs[0].external_id.localeCompare(
          right.external_refs[0].external_id,
        ),
      );
    assert.deepEqual(
      firstTracks.map((record) => record.external_refs[0].external_id),
      secondTracks.map((record) => record.external_refs[0].external_id),
    );
    assert.ok(
      firstTracks.every(
        (record, index) =>
          record.track_ref_id !== secondTracks[index].track_ref_id,
      ),
    );
  }

  const fallbackFirst = first.trackRefs.find(
    (record) => record.title === "No Stable ID",
  );
  const fallbackSecond = second.trackRefs.find(
    (record) => record.title === "No Stable ID",
  );
  assert.notEqual(fallbackFirst.track_ref_id, fallbackSecond.track_ref_id);
});

test("identical metadata with different persistent IDs is not merged", async () => {
  const records = await normalizedFixture();
  const matches = records.trackRefs.filter(
    (trackRef) => trackRef.title === "Synthetic Alpha",
  );

  assert.equal(matches.length, 2);
  assert.notEqual(matches[0].track_ref_id, matches[1].track_ref_id);
});

test("conflicting metadata for one persistent ID fails closed", async () => {
  const parsed = parsedFixture();
  parsed.root.Tracks["3"]["Persistent ID"] =
    parsed.root.Tracks["1"]["Persistent ID"];

  await assert.rejects(
    normalizeAppleMusicLibrary(parsed, { subjectId }),
    (error) => assertImportError(error, "duplicate_persistent_id_conflict"),
  );
});

test("an identical duplicate persistent ID is deterministically deduplicated", async () => {
  const parsed = parsedFixture();
  parsed.root.Tracks["4"] = structuredClone(parsed.root.Tracks["1"]);
  parsed.trackCount = 4;

  const records = await normalizeAppleMusicLibrary(parsed, { subjectId });

  assert.equal(records.trackRefs.length, 3);
  assert.equal(records.trackSnapshots.length, 3);
  assert.ok(
    records.warnings.some(
      (warning) => warning.code === "duplicate_persistent_id_deduplicated",
    ),
  );
});

test("a duplicate persistent ID with different aggregate state fails closed", async () => {
  const parsed = parsedFixture();
  parsed.root.Tracks["4"] = structuredClone(parsed.root.Tracks["1"]);
  parsed.root.Tracks["4"]["Play Count"] = 100;
  parsed.trackCount = 4;

  await assert.rejects(
    normalizeAppleMusicLibrary(parsed, { subjectId }),
    (error) => assertImportError(error, "duplicate_persistent_id_conflict"),
  );
});

test("long metadata cannot overflow core TrackRef strings", async () => {
  const parsed = parsedFixture();
  parsed.root.Tracks["1"].Name = "T".repeat(300);
  parsed.root.Tracks["1"].Artist = "A".repeat(300);
  parsed.root.Tracks["1"].Album = "B".repeat(513);

  const records = await normalizeAppleMusicLibrary(parsed, { subjectId });
  const track = records.trackRefs.find(
    (record) => record.extensions?.["apple_music.genre"],
  );

  assert.equal(Array.from(track.display_label).length, 512);
  assert.equal(track.release, undefined);
  assert.ok(
    records.warnings.some(
      (warning) => warning.code === "display_label_truncated",
    ),
  );
  assert.ok(
    records.warnings.some(
      (warning) =>
        warning.code === "field_length_invalid" && warning.field === "album",
    ),
  );
});

test("UUIDv7 subjects are accepted and UUID case is canonicalized", async () => {
  const lowercase = "018f22e2-79b0-7cc3-98c4-dc0c0c0c0c0c";
  const upper = lowercase.toUpperCase();

  const first = await normalizeAppleMusicLibrary(parsedFixture(), {
    subjectId: lowercase,
  });
  const second = await normalizeAppleMusicLibrary(parsedFixture(), {
    subjectId: upper,
  });

  assert.equal(canonicalizeJson(first), canonicalizeJson(second));
  assert.equal(first.manifest.subject_id, lowercase);
});

test("parser accepts the Apple doctype but rejects unsafe XML constructs", () => {
  assert.equal(parsedFixture().trackCount, 3);

  const entityXml = fixtureXml.replace(
    '<plist version="1.0">',
    '<!ENTITY local SYSTEM "file:///etc/passwd">\n<plist version="1.0">',
  );
  assert.throws(
    () => parseAppleMusicLibraryBuffer(Buffer.from(entityXml)),
    (error) => assertImportError(error, "xml_entity_forbidden"),
  );

  const duplicateKeyXml = fixtureXml.replace(
    "<key>Major Version</key><integer>1</integer>",
    "<key>Major Version</key><integer>1</integer><key>Major Version</key><integer>2</integer>",
  );
  assert.throws(
    () => parseAppleMusicLibraryBuffer(Buffer.from(duplicateKeyXml)),
    (error) => assertImportError(error, "xml_duplicate_dict_key"),
  );

  const attributedKeyXml = fixtureXml.replace(
    "<key>Major Version</key>",
    '<key synthetic="attribute">Major Version</key>',
  );
  assert.throws(
    () => parseAppleMusicLibraryBuffer(Buffer.from(attributedKeyXml)),
    (error) => assertImportError(error, "xml_tag_attributes_forbidden"),
  );

  const emptyKeyXml = fixtureXml.replace(
    "<key>Major Version</key>",
    "<key/>",
  );
  assert.throws(
    () => parseAppleMusicLibraryBuffer(Buffer.from(emptyKeyXml)),
    (error) => assertImportError(error, "xml_empty_key_forbidden"),
  );

  const malformedXml = fixtureXml.replace("</dict>\n</plist>", "</plist>");
  assert.throws(
    () => parseAppleMusicLibraryBuffer(Buffer.from(malformedXml)),
    (error) => assertImportError(error, "xml_structure_invalid"),
  );

  assert.throws(
    () =>
      parseAppleMusicLibraryBuffer(
        Buffer.from(`PRIVATE_PREFIX_SENTINEL\n${fixtureXml}`),
      ),
    (error) => assertImportError(error, "plist_envelope_invalid"),
  );
  assert.throws(
    () =>
      parseAppleMusicLibraryBuffer(
        Buffer.from(`${fixtureXml}\nPRIVATE_SUFFIX_SENTINEL`),
      ),
    (error) => assertImportError(error, "plist_envelope_invalid"),
  );
});

test("parser enforces the configured byte limit before parsing", () => {
  assert.throws(
    () =>
      parseAppleMusicLibraryBuffer(fixtureBuffer, {
        limits: { maxBytes: fixtureBuffer.length - 1 },
      }),
    (error) => assertImportError(error, "input_byte_limit"),
  );
});

test("text limits cover numeric plist leaves", () => {
  const xml = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>A</key><integer>123456</integer></dict></plist>',
  );
  assert.throws(
    () =>
      parseAppleMusicLibraryBuffer(xml, {
        limits: { maxTextBytes: 5 },
      }),
    (error) => assertImportError(error, "xml_text_limit"),
  );
});

test("CLI parser failures never echo private source text", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "moondog-cli-test-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const inputPath = path.join(temporaryRoot, "invalid.xml");
  const marker = "PRIVATE_XML_DIAGNOSTIC_SENTINEL";
  await writeFile(
    inputPath,
    fixtureXml.replace("Synthetic Alpha", `&${marker};`),
  );

  await assert.rejects(
    execFile(process.execPath, [cliPath, "inspect", "--input", inputPath]),
    (error) => {
      assert.equal(error.stderr.includes(marker), false);
      assert.match(error.stderr, /plist_parse_diagnostic/);
      return true;
    },
  );
});

test("private batch writes atomically, uses private modes, and is idempotent", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "moondog-apple-test-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const outputRoot = path.join(temporaryRoot, "imports");
  const records = await normalizedFixture();

  const first = await writeAppleMusicImportBatch(records, {
    outputRoot,
    boundaryRoot: temporaryRoot,
  });
  assert.equal(first.status, "written");
  const batchDirectory = path.join(outputRoot, first.batchDirectoryName);
  assert.deepEqual((await readdir(batchDirectory)).sort(), [
    "manifest.json",
    "track-refs.ndjson",
    "track-snapshots.ndjson",
    "warnings.ndjson",
  ]);

  if (process.platform !== "win32") {
    assert.equal((await stat(batchDirectory)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(path.join(batchDirectory, "manifest.json"))).mode & 0o777,
      0o600,
    );
  }

  const allOutput = (
    await Promise.all(
      (await readdir(batchDirectory)).map((name) =>
        readFile(path.join(batchDirectory, name), "utf8"),
      ),
    )
  ).join("\n");
  assert.equal(allOutput.includes("AAAABBBBCCCCDDDD"), false);
  assert.equal(allOutput.includes("file:///Users/synthetic/private/"), false);

  const second = await writeAppleMusicImportBatch(records, {
    outputRoot,
    boundaryRoot: temporaryRoot,
  });
  assert.equal(second.status, "unchanged");

  const manifestPath = path.join(batchDirectory, "manifest.json");
  const originalManifest = await readFile(manifestPath, "utf8");
  const duplicateKeyManifest = originalManifest.replace(
    '"schema_version": "apple-music-library-import-manifest/1"',
    '"schema_version": "PRIVATE_DUPLICATE_KEY_SENTINEL",\n  "schema_version": "apple-music-library-import-manifest/1"',
  );
  await writeFile(manifestPath, duplicateKeyManifest);
  await assert.rejects(
    writeAppleMusicImportBatch(records, {
      outputRoot,
      boundaryRoot: temporaryRoot,
    }),
    (error) => assertImportError(error, "existing_batch_conflict"),
  );
  await writeFile(manifestPath, originalManifest);

  const unexpectedPath = path.join(batchDirectory, "unexpected.txt");
  await writeFile(unexpectedPath, "unexpected\n", { mode: 0o600 });
  await assert.rejects(
    writeAppleMusicImportBatch(records, {
      outputRoot,
      boundaryRoot: temporaryRoot,
    }),
    (error) => assertImportError(error, "existing_batch_conflict"),
  );
  await rm(unexpectedPath);

  await writeFile(path.join(batchDirectory, "track-refs.ndjson"), "corrupt\n");
  await assert.rejects(
    writeAppleMusicImportBatch(records, {
      outputRoot,
      boundaryRoot: temporaryRoot,
    }),
    (error) => assertImportError(error, "existing_batch_conflict"),
  );
});

test("writer rejects mutated unsafe records before creating output", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "moondog-writer-test-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const outputRoot = path.join(temporaryRoot, "imports");
  const records = await normalizedFixture();
  records.trackRefs[0].extensions ??= {};
  records.trackRefs[0].extensions["apple_music.password"] = "synthetic-secret";

  await assert.rejects(
    writeAppleMusicImportBatch(records, {
      outputRoot,
      boundaryRoot: temporaryRoot,
    }),
    (error) => assertImportError(error, "normalized_record_unsafe"),
  );
  await assert.rejects(stat(outputRoot), { code: "ENOENT" });
});

test("writer rejects a symlinked output ancestor", async (t) => {
  if (process.platform === "win32") t.skip("POSIX symlink semantics required");
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "moondog-link-test-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const boundaryRoot = path.join(temporaryRoot, "boundary");
  const outsideRoot = path.join(temporaryRoot, "outside");
  await mkdir(boundaryRoot);
  await mkdir(outsideRoot);
  await symlink(outsideRoot, path.join(boundaryRoot, "data"), "dir");
  const records = await normalizedFixture();

  await assert.rejects(
    writeAppleMusicImportBatch(records, {
      outputRoot: path.join(boundaryRoot, "data", "imports"),
      boundaryRoot,
    }),
    (error) => assertImportError(error, "output_path_symlink_forbidden"),
  );
  assert.deepEqual(await readdir(outsideRoot), []);
});
