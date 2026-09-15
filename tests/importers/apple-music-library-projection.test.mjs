import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalizeJson } from "../../scripts/contract-semantics.mjs";
import { openAppleProjectionDomainServices } from "../../src/core/apple-projection-domain-services.mjs";
import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";
import { buildTasteProfileModel } from "../../src/surfaces/cli/taste-profile-model.mjs";
import {
  AppleMusicImportError,
  normalizeAppleMusicLibrary,
  openAppleMusicSqliteProjection,
  parseAppleMusicLibraryBuffer,
  promoteAppleMusicImportBatches,
  readAppleMusicImportBatch,
  rebuildAppleMusicSqliteProjection,
  writeAppleMusicImportBatch,
} from "../../src/importers/apple-music-library/index.mjs";

const fixturePath = fileURLToPath(
  new URL("../fixtures/apple-music-library/minimal.xml", import.meta.url),
);
const fixtureBuffer = await readFile(fixturePath);
const subjectId = "11111111-2222-4333-8444-555555555555";
const otherSubjectId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function parsedFixture() {
  return parseAppleMusicLibraryBuffer(Buffer.from(fixtureBuffer));
}

async function normalizedFixture() {
  return normalizeAppleMusicLibrary(parsedFixture(), { subjectId });
}

async function secondNormalizedFixture() {
  const parsed = parsedFixture();
  parsed.sourceSha256 = "f".repeat(64);
  parsed.capturedAt = "2026-08-26T04:37:31.000Z";
  parsed.root.Tracks["1"].Name = "Synthetic Alpha Revised";
  return normalizeAppleMusicLibrary(parsed, { subjectId });
}

async function privateImports(t, records) {
  const importRecords = records ?? (await normalizedFixture());
  const root = await mkdtemp(path.join(tmpdir(), "moondog-projection-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const importsRoot = path.join(root, "imports");
  const result = await writeAppleMusicImportBatch(importRecords, {
    outputRoot: importsRoot,
    boundaryRoot: root,
  });
  return {
    root,
    importsRoot,
    batchDirectory: path.join(importsRoot, result.batchDirectoryName),
    records: importRecords,
  };
}

function assertImportError(error, code) {
  return error instanceof AppleMusicImportError && error.code === code;
}

test("promotion reconciles only exact anchors and is deterministic", async () => {
  const first = await normalizedFixture();
  const second = await secondNormalizedFixture();
  const once = await promoteAppleMusicImportBatches([first], { subjectId });
  const repeated = await promoteAppleMusicImportBatches([first, first], {
    subjectId,
  });
  const promoted = await promoteAppleMusicImportBatches([second, first], {
    subjectId,
  });
  const rebuilt = await promoteAppleMusicImportBatches([first, second], {
    subjectId,
  });

  assert.equal(canonicalizeJson(once), canonicalizeJson(repeated));
  assert.equal(canonicalizeJson(promoted), canonicalizeJson(rebuilt));
  assert.deepEqual(promoted.counts, {
    current_tracks: 3,
    observations: 6,
    profile_evidence: 2,
    listening_events: 0,
    taste_events: 0,
    unresolved_identities: 2,
  });

  const changedAnchor = first.trackRefs.find(
    (trackRef) => trackRef.extensions?.["apple_music.genre"],
  ).external_refs[0].external_id;
  const changedRevisions = promoted.trackRefs.filter(
    (trackRef) => trackRef.external_refs[0].external_id === changedAnchor,
  );
  assert.deepEqual(
    changedRevisions.map((trackRef) => trackRef.revision),
    [1, 2],
  );
  assert.equal(
    changedRevisions[0].track_ref_id,
    changedRevisions[1].track_ref_id,
  );
  assert.deepEqual(changedRevisions[1].supersedes, {
    track_ref_id: changedRevisions[0].track_ref_id,
    revision: 1,
  });
  assert.ok(
    promoted.trackRefs.every(
      (trackRef) => trackRef.identity_status === "provisional",
    ),
  );

  const fallbackTracks = promoted.trackRefs.filter(
    (trackRef) => trackRef.title === "No Stable ID",
  );
  assert.equal(fallbackTracks.length, 2);
  assert.notEqual(fallbackTracks[0].track_ref_id, fallbackTracks[1].track_ref_id);

  const sameMetadataTracks = promoted.currentTrackRefs.filter((trackRef) =>
    trackRef.title.startsWith("Synthetic Alpha"),
  );
  assert.equal(sameMetadataTracks.length, 2);
  assert.notEqual(
    sameMetadataTracks[0].track_ref_id,
    sameMetadataTracks[1].track_ref_id,
  );
  assert.equal(
    new Set(
      promoted.observations.map(
        (observation) => observation.library_track_observation_id,
      ),
    ).size,
    promoted.observations.length,
  );
  assert.ok(
    promoted.profileEvidence.every(
      (evidence) =>
        evidence.schema_version === 2 &&
        evidence.derivation.kind === "rule" &&
        evidence.derivation.parameters_digest,
    ),
  );
  assert.ok(
    promoted.profileEvidence.some(
      (evidence) => evidence.claim.dimension === "taste.track_familiarity",
    ),
  );
  assert.equal(
    promoted.profileEvidence.some(
      (evidence) =>
        evidence.derivation.name === "provider-rating-track-preference",
    ),
    false,
    "computed ratings must not become preference evidence",
  );
});

test("verified batch reader rejects a changed data file", async (t) => {
  const { batchDirectory, records } = await privateImports(t);
  const read = await readAppleMusicImportBatch(batchDirectory, {
    expectedSubjectId: subjectId,
  });
  assert.equal(canonicalizeJson(read), canonicalizeJson(records));

  await writeFile(path.join(batchDirectory, "track-refs.ndjson"), "corrupt\n");
  await assert.rejects(
    readAppleMusicImportBatch(batchDirectory),
    (error) => assertImportError(error, "batch_data_invalid"),
  );
});

test("SQLite projection rebuild, search, profile, and digest stay bounded", async (t) => {
  const { root, importsRoot, batchDirectory, records } = await privateImports(t);
  const databasePath = path.join(root, "indexes", "moondog.sqlite");

  const first = await rebuildAppleMusicSqliteProjection({
    importsRoot,
    databasePath,
    boundaryRoot: root,
  });
  assert.deepEqual(first.counts, {
    current_tracks: 3,
    observations: 3,
    profile_evidence: 2,
    listening_events: 0,
    taste_events: 0,
    unresolved_identities: 1,
  });
  if (process.platform !== "win32") {
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  }
  const rawDatabase = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(rawDatabase.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(
    rawDatabase.prepare("PRAGMA journal_mode").get().journal_mode,
    "delete",
  );
  rawDatabase.close();

  let projection = await openAppleMusicSqliteProjection({
    databasePath,
    subjectId,
  });
  assert.equal(first.logical_digest, projection.logicalDigest());
  assert.equal(
    projection.searchLibrary({ query: "Synthetic", limit: 10 }).tracks.length,
    2,
  );
  const firstSyntheticPage = projection.searchLibrary({
    query: "Synthetic",
    limit: 1,
    offset: 0,
  });
  const secondSyntheticPage = projection.searchLibrary({
    query: "Synthetic",
    limit: 1,
    offset: 1,
  });
  assert.notEqual(
    firstSyntheticPage.tracks[0].track_ref.track_ref_id,
    secondSyntheticPage.tracks[0].track_ref.track_ref_id,
  );
  assert.equal(secondSyntheticPage.offset, 1);
  assert.equal(
    projection.searchLibrary({ query: "Example Composer", limit: 10 }).tracks
      .length,
    1,
  );
  assert.equal(
    projection.searchLibrary({ query: "Synthetic Genre", limit: 10 }).tracks
      .length,
    1,
  );
  assert.equal(
    projection.searchLibrary({ query: "No", limit: 10 }).tracks.length,
    1,
  );
  assert.doesNotThrow(() =>
    projection.searchLibrary({ query: 'Synthetic" OR *', limit: 10 }),
  );
  assert.equal(
    projection.searchLibrary({
      query: "",
      filters: { genre: "Synthetic Genre' OR 1=1 --" },
    }).tracks.length,
    0,
  );
  assert.equal(
    projection.searchLibrary({
      query: "",
      filters: { artists: ["Example Artist"] },
    }).tracks.length,
    2,
  );
  assert.equal(
    projection.searchLibrary({
      query: "",
      filters: { genres: ["Synthetic Genre"] },
    }).tracks.length,
    1,
  );
  assert.equal(
    projection.searchLibrary({
      query: "",
      filters: { familiarity: ["high"] },
    }).tracks.length,
    1,
  );
  assert.equal(
    projection.searchLibrary({
      query: "",
      filters: { preferenceSignals: ["loved"] },
    }).tracks.length,
    1,
  );
  assert.equal(
    projection.searchLibrary({
      query: "",
      filters: { preferenceSignals: ["rated"] },
    }).tracks.length,
    0,
  );
  assert.equal(
    projection.searchLibrary({
      query: "",
      filters: { artists: ["Example%' OR 1=1 --"] },
    }).tracks.length,
    0,
  );
  assert.throws(
    () => projection.searchLibrary({ query: "", limit: 26 }),
    /between 1 and 25/,
  );

  const safeSearch = projection.searchLibrary({ query: "Synthetic", limit: 1 });
  const serializedSearch = JSON.stringify(safeSearch);
  assert.equal(serializedSearch.includes(subjectId), false);
  assert.equal(serializedSearch.includes("external_id"), false);
  assert.equal(serializedSearch.includes("source_batch_ref"), false);
  assert.equal(
    records.trackRefs.some((trackRef) =>
      serializedSearch.includes(trackRef.external_refs[0].external_id),
    ),
    false,
  );

  const profile = projection.getProfileSummary({ maxItems: 10 });
  assert.equal(profile.preference.length, 1);
  assert.equal(profile.familiarity.length, 1);
  assert.equal(profile.coverage.current_tracks, 3);
  assert.equal(profile.coverage.loved_or_favorited, 1);
  assert.equal(profile.coverage.aggregate_play_count, 1);
  assert.equal(profile.coverage.non_computed_rating, 0);
  assert.equal(profile.preference[0].artist_credit, "Example Artist");
  assert.equal(
    profile.preference[0].labels.provider_genre,
    "Synthetic Genre",
  );
  assert.equal(profile.familiarity[0].observation_summary.play_count, 99);
  const onePerDimension = projection.getProfileSummary({ maxItems: 1 });
  assert.equal(onePerDimension.preference.length, 1);
  assert.equal(onePerDimension.familiarity.length, 1);
  const explanation = projection.explainProfileEvidence({
    evidenceId: profile.familiarity[0].evidence_id,
  });
  assert.match(explanation.limitation, /familiarity, not liking/);
  assert.equal(JSON.stringify(explanation).includes("source_record_digest"), false);
  projection.close();

  const domainServices = await openAppleProjectionDomainServices({
    databasePath,
    importsRoot,
  });
  assert.equal(domainServices.status().subject_scope, "trusted_runtime");
  domainServices.close();

  await unlink(databasePath);
  const second = await rebuildAppleMusicSqliteProjection({
    importsRoot,
    databasePath,
    boundaryRoot: root,
    subjectId,
  });
  assert.equal(second.logical_digest, first.logical_digest);

  await writeFile(path.join(batchDirectory, "track-refs.ndjson"), "corrupt\n");
  await assert.rejects(
    rebuildAppleMusicSqliteProjection({
      importsRoot,
      databasePath,
      boundaryRoot: root,
      subjectId,
    }),
    (error) => assertImportError(error, "batch_data_invalid"),
  );
  projection = await openAppleMusicSqliteProjection({
    databasePath,
    subjectId,
  });
  assert.equal(projection.logicalDigest(), first.logical_digest);
  projection.close();
});

test("imported Apple track corrections use canonical titles and remain retractable", async (t) => {
  const parsed = parsedFixture();
  parsed.root.Tracks["1"].Name = "Shared - Title";
  parsed.root.Tracks["1"].Artist = "Artist - One";
  parsed.root.Tracks["2"].Name = "Shared - Title";
  parsed.root.Tracks["2"].Artist = "Artist Two";
  parsed.root.Tracks["2"].Loved = true;
  const records = await normalizeAppleMusicLibrary(parsed, { subjectId });
  const { root, importsRoot } = await privateImports(t, records);
  const databasePath = path.join(root, "projection.sqlite");
  await rebuildAppleMusicSqliteProjection({ importsRoot, databasePath, boundaryRoot: root });
  const store = await openListeningHistoryStore({ databasePath: path.join(root, "history.sqlite") });
  store.localSubjectId({ preferredSubjectId: subjectId, create: true });
  const services = await openAppleProjectionDomainServices({
    importsRoot, databasePath, subjectId, listeningHistoryStore: store,
  });
  try {
    const before = await services.getProfileSummary({ maxItems: 10 });
    const profileModel = buildTasteProfileModel(before);
    const first = profileModel.subjects.find((item) =>
      item.kind === "track" && item.target.artistCredit === "Artist - One",
    );
    assert.deepEqual(first.target, {
      entityType: "track", label: "Shared - Title", artistCredit: "Artist - One",
    });
    assert.equal(profileModel.subjects.filter((item) => item.kind === "track").length, 2);
    const correction = store.recordListenerCorrection({ subjectId, ...first.target, stance: "avoid" });
    const corrected = await services.getProfileSummary({ maxItems: 10 });
    assert.deepEqual(corrected.strong_preferences.map((item) => item.artist_credit), ["Artist Two"]);
    assert.equal(corrected.familiarity[0].label, "Shared - Title");
    assert.equal(corrected.familiarity[0].play_count, 99);
    const correctedModel = buildTasteProfileModel(corrected);
    const avoided = correctedModel.subjects.find((item) => item.target.artistCredit === "Artist - One");
    assert.equal(avoided.stance, "avoid");
    assert.equal(avoided.correctionId, correction.correction_id);
    assert.equal(correctedModel.subjects.filter((item) => item.kind === "track").length, 2);
    assert.ok((await services.explainProfileEvidence({ evidenceId: first.evidenceId })).claim);

    store.retractListenerCorrection({ subjectId, correctionId: correction.correction_id });
    const restored = await services.getProfileSummary({ maxItems: 10 });
    assert.deepEqual(restored.strong_preferences, before.strong_preferences);
    assert.deepEqual(restored.familiarity, before.familiarity);
    assert.equal(restored.coverage.effective_listening_events, 0);
  } finally {
    services.close();
  }
});

test("persisted Apple display-label corrections resolve without rewriting and exact titles win", async (t) => {
  for (const canonicalCollision of [false, true]) {
    const parsed = parsedFixture();
    if (canonicalCollision) {
      parsed.root.Tracks["2"].Name = "Synthetic Alpha - Example Artist";
      parsed.root.Tracks["2"].Loved = true;
    }
    const records = await normalizeAppleMusicLibrary(parsed, { subjectId });
    const { root, importsRoot } = await privateImports(t, records);
    const databasePath = path.join(root, "projection.sqlite");
    const historyPath = path.join(root, "history.sqlite");
    await rebuildAppleMusicSqliteProjection({ importsRoot, databasePath, boundaryRoot: root });
    let store = await openListeningHistoryStore({ databasePath: historyPath });
    store.localSubjectId({ preferredSubjectId: subjectId, create: true });
    const oldTarget = {
      entityType: "track", label: "Synthetic Alpha - Example Artist", artistCredit: "Example Artist",
    };
    const correction = store.recordListenerCorrection({ subjectId, ...oldTarget, stance: "avoid" });
    store.close();
    store = await openListeningHistoryStore({ databasePath: historyPath });
    const services = await openAppleProjectionDomainServices({
      importsRoot, databasePath, subjectId, listeningHistoryStore: store,
    });
    try {
      const profile = await services.getProfileSummary({ maxItems: 10 });
      assert.deepEqual(profile.strong_preferences.map((item) => item.label), canonicalCollision ? ["Synthetic Alpha"] : []);
      assert.equal(profile.listener_assertions.avoids[0].label, canonicalCollision ? oldTarget.label : "Synthetic Alpha");
      assert.equal(profile.listener_assertions.avoids[0].correction_id, correction.correction_id);
      const model = buildTasteProfileModel(profile);
      const avoided = model.subjects.find((item) => item.correctionId === correction.correction_id);
      assert.equal(avoided.stance, "avoid");
      assert.equal(avoided.label, canonicalCollision ? oldTarget.label : "Synthetic Alpha");
      assert.equal(store.listListenerCorrections({ subjectId })[0].label, oldTarget.label);
      store.retractListenerCorrection({ subjectId, correctionId: correction.correction_id });
      const restored = await services.getProfileSummary({ maxItems: 10 });
      assert.equal(restored.strong_preferences.length, canonicalCollision ? 2 : 1);
    } finally {
      services.close();
    }
  }
});

test("SQLite projection refuses inferred rebuilds across subjects", async (t) => {
  const { root, importsRoot } = await privateImports(t);
  const otherRecords = await normalizeAppleMusicLibrary(parsedFixture(), {
    subjectId: otherSubjectId,
  });
  const foreignImport = await writeAppleMusicImportBatch(otherRecords, {
    outputRoot: importsRoot,
    boundaryRoot: root,
  });
  await writeFile(
    path.join(
      importsRoot,
      foreignImport.batchDirectoryName,
      "track-refs.ndjson",
    ),
    "foreign scope must not be read\n",
  );

  await assert.rejects(
    rebuildAppleMusicSqliteProjection({
      importsRoot,
      databasePath: path.join(root, "indexes", "moondog.sqlite"),
      boundaryRoot: root,
    }),
    (error) => assertImportError(error, "projection_subject_mismatch"),
  );

  const scoped = await rebuildAppleMusicSqliteProjection({
    importsRoot,
    databasePath: path.join(root, "indexes", "scoped-moondog.sqlite"),
    boundaryRoot: root,
    subjectId,
  });
  assert.equal(scoped.counts.current_tracks, 3);
});

test("runtime subject scope comes from canonical imports, not projection metadata", async (t) => {
  const trusted = await privateImports(t);
  const foreignRecords = await normalizeAppleMusicLibrary(parsedFixture(), {
    subjectId: otherSubjectId,
  });
  const foreign = await privateImports(t, foreignRecords);
  const foreignDatabasePath = path.join(
    foreign.root,
    "indexes",
    "moondog.sqlite",
  );
  await rebuildAppleMusicSqliteProjection({
    importsRoot: foreign.importsRoot,
    databasePath: foreignDatabasePath,
    boundaryRoot: foreign.root,
  });

  await assert.rejects(
    openAppleProjectionDomainServices({
      databasePath: foreignDatabasePath,
      importsRoot: trusted.importsRoot,
    }),
    (error) => assertImportError(error, "projection_subject_mismatch"),
  );
});

test("projection digest covers model-visible search, metadata, and FTS state", async (t) => {
  const { root, importsRoot } = await privateImports(t);
  const databasePath = path.join(root, "indexes", "moondog.sqlite");

  const rebuild = () =>
    rebuildAppleMusicSqliteProjection({
      importsRoot,
      databasePath,
      boundaryRoot: root,
    });
  const assertDigestMismatch = () =>
    assert.rejects(
      openAppleMusicSqliteProjection({ databasePath, subjectId }),
      (error) => assertImportError(error, "projection_digest_mismatch"),
    );

  await rebuild();
  let database = new DatabaseSync(databasePath);
  database.prepare("UPDATE library_search SET title = ? WHERE rowid = 1").run(
    "Altered model-visible title",
  );
  database.close();
  await assertDigestMismatch();

  await rebuild();
  database = new DatabaseSync(databasePath);
  database
    .prepare("UPDATE projection_meta SET value = ? WHERE key = ?")
    .run(JSON.stringify("2099-01-01T00:00:00.000Z"), "projection.source_timestamp");
  database.close();
  await assertDigestMismatch();

  await rebuild();
  database = new DatabaseSync(databasePath);
  database
    .prepare("INSERT INTO library_fts(library_fts) VALUES (?)")
    .run("delete-all");
  database.close();
  await assertDigestMismatch();
});

test("domain startup rejects a projection that is stale against canonical imports", async (t) => {
  const { root, importsRoot } = await privateImports(t);
  const databasePath = path.join(root, "indexes", "moondog.sqlite");
  await rebuildAppleMusicSqliteProjection({
    importsRoot,
    databasePath,
    boundaryRoot: root,
  });

  await writeAppleMusicImportBatch(await secondNormalizedFixture(), {
    outputRoot: importsRoot,
    boundaryRoot: root,
  });

  await assert.rejects(
    openAppleProjectionDomainServices({ databasePath, importsRoot }),
    (error) => assertImportError(error, "projection_input_mismatch"),
  );
});

test("CJK substring search uses the bounded literal fallback", async (t) => {
  const parsed = parsedFixture();
  parsed.sourceSha256 = "e".repeat(64);
  parsed.root.Tracks["1"].Name = "夜曲测试";
  const records = await normalizeAppleMusicLibrary(parsed, { subjectId });
  const { root, importsRoot } = await privateImports(t, records);
  const databasePath = path.join(root, "indexes", "moondog.sqlite");
  await rebuildAppleMusicSqliteProjection({
    importsRoot,
    databasePath,
    boundaryRoot: root,
    subjectId,
  });
  const projection = await openAppleMusicSqliteProjection({
    databasePath,
    subjectId,
  });
  const result = projection.searchLibrary({ query: "夜曲", limit: 5 });
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].title, "夜曲测试");
  projection.close();
});
