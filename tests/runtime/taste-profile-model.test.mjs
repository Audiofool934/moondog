import assert from "node:assert/strict";
import test from "node:test";

import { createAppleProjectionDomainServices } from "../../src/core/apple-projection-domain-services.mjs";
import { createListeningProfileDomainServices } from "../../src/core/listening-profile-domain-services.mjs";
import { projectSpotifyRecentActivity } from "../../src/integrations/spotify/recent-activity.mjs";
import { openEphemeralListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";
import { buildTasteProfileModel } from "../../src/surfaces/cli/taste-profile-model.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";
const evidence = (number) => `20000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

test("taste review merges structured identities and retains every evidence source", () => {
  const profile = {
    coverage: { effective_listening_events: 12, listening_hours: 1.5, listening_tracks: 3 },
    listening_source: {
      providers: ["spotify"],
      listening_range: { earliest: "2024-01-01T01:00:00Z", latest: "2026-09-01T01:00:00Z" },
    },
    listening_behavior: {
      repeat_tracks: [{ label: "Ｅchoes", artist_credit: "  North\nWindow ", play_count: 12, engaged_play_count: 9, listening_minutes: 40, evidence_id: evidence(1) }],
      recent_tracks: [
        { label: "echoes", artist_credit: "north window", play_count: 2, last_played_at: "2026-09-01T01:00:00Z", evidence_id: evidence(2) },
        { label: "Echoes", artist_credit: "Another Artist", play_count: 1, evidence_id: evidence(3) },
      ],
    },
    curated_preferences: {
      saved_tracks: [{ label: "Echoes", artist_credit: "North Window", evidence_id: evidence(4) }],
    },
    familiarity: [{ label: "Danger - Parsed Artist", play_count: 5, evidence_id: evidence(5) }],
    strong_preferences: [{ label: "An Album", artist_credit: "North Window", signal: "Saved album", evidence_id: evidence(6) }],
  };
  const original = structuredClone(profile);
  const model = buildTasteProfileModel(profile);
  assert.deepEqual(profile, original);
  assert.equal(model.subjects.length, 2);
  const track = model.subjects[0];
  assert.deepEqual(track.target, { entityType: "track", label: "Ｅchoes", artistCredit: "  North\nWindow " });
  assert.equal(track.subtitle, "North Window");
  assert.equal(track.stance, undefined);
  assert.equal(track.correctionId, undefined);
  assert.deepEqual(track.evidence.map((item) => item.id), [evidence(1), evidence(2), evidence(4)]);
  assert.equal(track.evidenceId, evidence(1));
  assert.match(track.detailLines.join("\n"), /12 plays.*9 engaged plays.*40 min/u);
  assert.match(track.detailLines.join("\n"), /2 plays.*last played 2026-09-01/u);
  assert.match(track.detailLines.join("\n"), /Saved in Spotify library/u);
  assert.doesNotMatch(track.detailLines.join("\n"), /confidence|Like/u);
  assert.match(model.summaryLines.join("\n"), /12 listening events.*1.5 h/u);
  assert.match(model.summaryLines.join("\n"), /2024-01-01 to 2026-09-01/u);
});

test("taste review sanitizes display without changing correction targets or parsing delimiters", () => {
  const rawLabel = "Title - Part II\u001b[2J\u202e\nFinal";
  const rawArtist = "Artist\tA";
  const model = buildTasteProfileModel({
    listener_assertions: {
      active: [{ entity_type: "track", label: rawLabel, artist_credit: rawArtist, stance: "like", correction_id: evidence(1), evidence_id: evidence(1), note: "Keep\nthis\u0007" }],
    },
  });
  const track = model.subjects[0];
  assert.equal(track.target.label, rawLabel);
  assert.equal(track.target.artistCredit, rawArtist);
  assert.equal(track.label, "Title - Part II[2J Final");
  assert.equal(track.subtitle, "Artist A");
  assert.equal(track.stance, "like");
  assert.equal(track.correctionId, evidence(1));
  assert.doesNotMatch([track.label, track.subtitle, ...track.detailLines].join(""), /[\u0000-\u001f\u202e]/u);
  assert.equal(buildTasteProfileModel({ listening_behavior: { repeat_tracks: [{ label: "Title - Artist" }] } }).subjects.length, 0);
});

test("taste review shows imported Avoid without exposing an own correction to retract", () => {
  const model = buildTasteProfileModel({
    curated_preferences: { avoids: [{ entity_type: "artist", label: "Imported Artist", evidence_id: evidence(1) }] },
  });
  assert.equal(model.subjects.length, 1);
  assert.equal(model.subjects[0].stance, undefined);
  assert.equal(model.subjects[0].correctionId, undefined);
  assert.match(model.subjects[0].detailLines.join("\n"), /Imported provider Avoid/u);
});

test("real listening projection keeps artist Avoid and track Like independent across refresh and reset", async (context) => {
  const store = await openEphemeralListeningHistoryStore();
  context.after(() => store.close());
  store.ingest(projectSpotifyRecentActivity({
    subjectId,
    capturedAt: "2026-09-01T05:00:00.000Z",
    page: {
      provider: "spotify",
      cursor_after_ms: Date.parse("2026-09-01T04:00:00.000Z"),
      items: [{
        played_at: "2026-09-01T04:00:00.000Z",
        track: { id: "synthetic-track", name: "Echoes - Live", artists: ["North Window"], album: "Night", duration_ms: 240000 },
        context_type: "album",
      }],
    },
  }));
  const services = createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId });
  const refresh = async () => buildTasteProfileModel(await services.getProfileSummary({ maxItems: 10 }));
  const initial = await refresh();
  assert.match(initial.summaryLines.join("\n"), /1 listening events.*1 tracks/u);
  assert.match(initial.summaryLines.join("\n"), /Listening time is unavailable/u);
  assert.doesNotMatch(initial.summaryLines.join("\n"), /0 h/u);
  const initialTrack = initial.subjects.find((item) => item.kind === "track");
  const avoided = store.recordListenerCorrection({
    subjectId, entityType: "artist", label: "North Window", stance: "avoid", occurredAt: "2026-09-02T01:00:00Z",
  });
  let model = await refresh();
  assert.equal(model.subjects[0].kind, "artist");
  assert.equal(model.subjects[0].correctionId, avoided.correction_id);
  let track = model.subjects.find((item) => item.kind === "track");
  assert.equal(track.key, initialTrack.key);
  assert.equal(track.correctionId, undefined);
  assert.equal(track.stance, undefined);
  assert.match(track.detailLines.join("\n"), /Artist correction: Avoid applies to North Window/u);
  assert.ok(track.evidence.some((item) => item.id === avoided.correction_id && item.source === "Your artist Avoid"));
  const liked = store.recordListenerCorrection({
    subjectId, ...track.target, stance: "like", occurredAt: "2026-09-02T02:00:00Z",
  });
  model = await refresh();
  track = model.subjects[0];
  assert.equal(track.key, initialTrack.key);
  assert.equal(track.stance, "like");
  assert.equal(track.correctionId, liked.correction_id);
  assert.equal(track.evidenceId, liked.correction_id);
  assert.match(track.detailLines.join("\n"), /track Like does not override the artist Avoid/u);
  assert.match(track.detailLines.join("\n"), /1 plays/u);
  for (const item of track.evidence) {
    const explanation = await services.explainProfileEvidence({ evidenceId: item.id });
    assert.equal(explanation.evidence_id, item.id);
  }
  store.retractListenerCorrection({ subjectId, correctionId: liked.correction_id, occurredAt: "2026-09-02T03:00:00Z" });
  model = await refresh();
  track = model.subjects.find((item) => item.kind === "track");
  assert.equal(track.key, initialTrack.key);
  assert.equal(track.stance, undefined);
  assert.equal(track.correctionId, undefined);
  assert.match(track.detailLines.join("\n"), /Artist correction: Avoid applies/u);
  assert.ok(track.evidence.every((item) => item.id !== liked.correction_id));
  store.retractListenerCorrection({ subjectId, correctionId: avoided.correction_id, occurredAt: "2026-09-02T04:00:00Z" });
  track = (await refresh()).subjects.find((item) => item.kind === "track");
  assert.equal(track.key, initialTrack.key);
  assert.doesNotMatch(track.detailLines.join("\n"), /Artist correction/u);
});

test("Apple-only summaries preserve correction identity and distinct artists for the same title", async () => {
  const row = (artist, id, extra = {}) => ({
    label: "Shared - Title", artist_credit: artist,
    track_ref: { track_ref_id: evidence(id + 10), revision: 1 },
    evidence_id: evidence(id), direction: "supports", strength: 0.8,
    confidence: 0.9, observed_at: "2026-09-01T00:00:00Z",
    observation_summary: { loved: true, play_count: 42 },
    ...extra,
  });
  const services = createAppleProjectionDomainServices({
    projection: {
      getProfileSummary: () => ({
        schema_version: "profile-projection/0",
        preference: [row("Artist - One", 1), row("Artist Two", 2)],
        familiarity: [row("Artist - One", 3)],
        coverage: { current_tracks: 2, loved_or_favorited: 2, source_timestamp: "2026-09-01T00:00:00Z" },
        limitations: [],
      }),
    },
  });
  const profile = await services.getProfileSummary({ maxItems: 10 });
  assert.equal(profile.strong_preferences.length, 2);
  assert.deepEqual(profile.strong_preferences.map((item) => item.artist_credit), ["Artist - One", "Artist Two"]);
  const model = buildTasteProfileModel(profile);
  const tracks = model.subjects.filter((item) => item.kind === "track");
  assert.equal(tracks.length, 2);
  assert.deepEqual(tracks[0].target, { entityType: "track", label: "Shared - Title", artistCredit: "Artist - One" });
  assert.equal(tracks[0].stance, undefined);
  assert.deepEqual(tracks[0].evidence.map((item) => item.id), [evidence(1), evidence(3)]);
  assert.match(tracks[0].detailLines.join("\n"), /Apple Music library preference: Loved.*confidence 90%/u);
  assert.match(tracks[0].detailLines.join("\n"), /Apple Music aggregate play count: 42 plays/u);
  assert.match(model.summaryLines.join("\n"), /Apple Music library: 2 tracks/u);
  const libraryOnly = buildTasteProfileModel({
    ...profile,
    coverage: { ...profile.coverage, effective_listening_events: 0, listening_hours: 0, listening_tracks: 0 },
  });
  assert.match(libraryOnly.summaryLines[0], /Apple Music library: 2 tracks/u);
  assert.doesNotMatch(libraryOnly.summaryLines.join("\n"), /0 listening events|0 h|0 tracks/u);
});

test("taste review tolerates an empty profile and bounds every input ranking", () => {
  assert.deepEqual(buildTasteProfileModel(null).subjects, []);
  assert.deepEqual(buildTasteProfileModel({}).summaryLines, []);
  assert.match(buildTasteProfileModel({}).emptyLines.join("\n"), /Import listening history/u);
  const model = buildTasteProfileModel({
    listening_behavior: { repeat_tracks: Array.from({ length: 20 }, (_, index) => ({ label: `Track ${index}`, artist_credit: "Artist" })) },
  });
  assert.equal(model.subjects.length, 10);
});
