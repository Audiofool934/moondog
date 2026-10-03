import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as plist from "plist";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

import { createAppleProjectionDomainServices } from "../../src/core/apple-projection-domain-services.mjs";
import { createListeningProfileDomainServices } from "../../src/core/listening-profile-domain-services.mjs";
import { openEphemeralListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";
import { projectSpotifyExtendedStreamingHistory } from "../../src/integrations/spotify/extended-streaming-history.mjs";
import { normalizeAppleMusicLibrary, parseAppleMusicLibraryBuffer, writeAppleMusicImportBatch,
  rebuildAppleMusicSqliteProjection, openAppleMusicSqliteProjection } from "../../src/importers/apple-music-library/index.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";

async function appleServices(t, listeningHistoryStore = null) {
  const parsed = parseAppleMusicLibraryBuffer(await readFile(new URL("../fixtures/apple-music-library/minimal.xml", import.meta.url)));
  parsed.root.Tracks = Object.fromEntries(Array.from({ length: 140 }, (_, index) => [String(index + 1), {
    "Track ID": index + 1, "Persistent ID": (index + 1).toString(16).padStart(16, "0"),
    Name: `Fixture song ${index}`, Artist: index < 60 ? "Small selection" : "Broad preference",
    Album: "Fixture album", Genre: index === 139 ? "" : index < 60 ? "Small genre" : "Broad genre",
    Loved: true, "Play Count": index + 1,
    ...(index < 60 ? { Favorited: true } : {}),
  }]));
  const root = await mkdtemp(path.join(tmpdir(), "moondog-full-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const importsRoot = path.join(root, "imports");
  const databasePath = path.join(root, "projection.sqlite");
  const rebuilt = parseAppleMusicLibraryBuffer(Buffer.from(plist.build(parsed.root)));
  await writeAppleMusicImportBatch(await normalizeAppleMusicLibrary(rebuilt, { subjectId }), { outputRoot: importsRoot, boundaryRoot: root });
  await rebuildAppleMusicSqliteProjection({ importsRoot, databasePath, boundaryRoot: root });
  const projection = await openAppleMusicSqliteProjection({ databasePath, subjectId });
  const services = createAppleProjectionDomainServices({ projection, subjectId, listeningHistoryStore });
  t.after(() => services.close());
  return services;
}

test("Apple artist and genre facets use preferences beyond the first fifty tracks", async (t) => {
  const store = await openEphemeralListeningHistoryStore();
  t.after(() => store.close());
  const services = await appleServices(t, store);
  const profile = await services.getProfileSummary({ maxItems: 1 });
  assert.equal(profile.coverage.tracks_observed, 140);
  assert.equal(profile.artist_facets[0].name, "Broad preference");
  assert.equal(profile.genre_facets[0].name, "Broad genre");
  const explanation = await services.explainProfileEvidence({ evidenceId: profile.artist_facets[0].evidence_id });
  assert.match(explanation.basis_summary, /80 tracks with positive provider preferences among 80 library tracks/u);
  const page = await services.exploreProfile({ section: "apple_tracks", query: "Fixture song 139" });
  assert.equal(page.matched, 1);
  assert.equal(page.items[0].label, "Fixture song 139");
  store.recordListenerCorrection({ subjectId, entityType: "artist", label: "Broad preference", stance: "avoid",
    occurredAt: "2026-09-01T00:00:00Z" });
  for (let index = 0; index < 60; index++) store.recordListenerCorrection({ subjectId, entityType: "artist",
    label: `Other artist ${index}`, stance: "avoid", occurredAt: "2026-09-02T00:00:00Z" });
  assert.equal((await services.getProfileSummary({ maxItems: 1 })).artist_facets[0].name, "Small selection");
  const avoided = await services.exploreProfile({ section: "apple_artists", query: "Broad preference" });
  assert.equal(avoided.items[0].library_tracks, 80);
  assert.equal(avoided.items[0].preferred_tracks, 0);
});

test("full profile exploration reaches every retained history track beyond summary limits", async (t) => {
  const store = await openEphemeralListeningHistoryStore();
  const services = createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId });
  t.after(() => services.close());
  const records = Array.from({ length: 141 }, (_, index) => ({
    ts: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(), ms_played: 180_000,
    master_metadata_track_name: `Fixture ${String(index).padStart(3, "0")}`,
    master_metadata_album_artist_name: "Fixture artist", master_metadata_album_album_name: "Fixture album",
    spotify_track_uri: `spotify:track:${String(index).padStart(22, "0")}`,
    incognito_mode: index === 140, skipped: false, shuffle: false, offline: false,
  }));
  const bundle = projectSpotifyExtendedStreamingHistory({ subjectId, records, capturedAt: "2026-09-01T00:00:00Z",
    archiveSha256: "a".repeat(64), archiveSizeBytes: 1000, memberNames: ["Streaming_History_Audio_2026.json"] });
  store.ingestImport(bundle);
  store.ingestImport(bundle);
  const summary = await services.getProfileSummary({ maxItems: 6 });
  assert.equal(summary.listening_behavior.repeat_tracks.length, 6);
  const seen = new Set();
  let offset = 0;
  do {
    const page = await services.exploreProfile({ section: "history_tracks", offset, limit: 17 });
    assert.equal(page.total, 140);
    for (const row of page.items) seen.add(row.label);
    offset = page.next_offset;
  } while (offset !== null);
  assert.equal(seen.size, 140);
  const tail = await services.exploreProfile({ section: "history_tracks", query: "Fixture 139" });
  assert.equal(tail.items[0].label, "Fixture 139");
  const explanation = await services.explainProfileEvidence({ evidenceId: tail.items[0].evidence_id });
  assert.ok(explanation);
  const overview = await services.exploreProfile({});
  assert.equal(overview.coverage.effective_listening_events, 141);
  assert.equal(overview.coverage.profiled_listening_events, 140);
  assert.equal(overview.coverage.stored_listening_events, 141);
  assert.equal(overview.context.incognito_events_excluded, 1);
  assert.equal(overview.context.recent_window_days, 90);
  await assert.rejects(services.exploreProfile({ subjectId }), /arguments/u);
  await assert.rejects(services.exploreProfile({ limit: 21 }), /selection/u);
});

test("Pi agent can inspect complete library coverage, a tail result, and its aggregate basis", async (t) => {
  const services = await appleServices(t);
  const application = new MoondogApplication({ domainServices: services, importsRoot: "/private/fixture-no-imports" });
  t.after(() => application.close());
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({ application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  const results = (context, name) => context.messages.filter((message) => message.role === "toolResult" && message.toolName === name)
    .map((message) => JSON.parse(message.content[0].text));
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("moondog_profile_explore", {}),
      fauxToolCall("moondog_profile_explore", { section: "apple_tracks", query: "Fixture song 139" }),
      fauxToolCall("moondog_profile_explore", { section: "apple_artists", limit: 1 }),
    ], { stopReason: "toolUse" }),
    (context) => {
      const [overview, tail, artist] = results(context, "moondog_profile_explore");
      assert.equal(overview.coverage.apple_library_tracks, 140);
      assert.equal(tail.items[0].label, "Fixture song 139");
      assert.equal(artist.items[0].preferred_tracks, 80);
      assert.equal(artist.total, 2);
      assert.equal(artist.next_offset, 1);
      assert.doesNotMatch(JSON.stringify([overview, tail, artist]), /PRIVATE_COMMENT|PRIVATE_GROUPING|subject_id|external_id|file:\/\//u);
      return fauxAssistantMessage([fauxToolCall("moondog_profile_explain", { evidence_id: artist.items[0].evidence_id })], { stopReason: "toolUse" });
    },
    (context) => {
      const [explanation] = results(context, "moondog_profile_explain");
      assert.match(explanation.basis_summary, /80 tracks/u);
      return fauxAssistantMessage([fauxText("The full library supports the broader preference.")]);
    },
  ]);
  const result = await runtime.prompt("Build my music profile from all my data.");
  assert.equal(result.text, "The full library supports the broader preference.");
});
