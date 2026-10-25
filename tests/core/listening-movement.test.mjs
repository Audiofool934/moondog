import assert from "node:assert/strict";
import test from "node:test";

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

import { createListeningProfileDomainServices } from "../../src/core/listening-profile-domain-services.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { projectSpotifyExtendedStreamingHistory } from "../../src/integrations/spotify/extended-streaming-history.mjs";
import { openEphemeralListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";
import { projectListeningProfile } from "../../src/profile/listening-profile-projection.mjs";
import { createListenerProfileInput, listenerProfileDossier, modelEvidence } from "../../src/profile/listener-profile-build.mjs";
import { exploreProfileCatalog, profileExplorationInput } from "../../src/profile/profile-exploration.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";
const dayMs = 86_400_000;
// The history ends in mid-2025, so its latest year is partial.
const latestYear = 2025;
const partialDays = 160;

function plays(artist, year, count) {
  return spread(artist, Date.UTC(year, 0, 1), year === latestYear ? partialDays : 360, count);
}

function spread(artist, startMs, span, count) {
  return Array.from({ length: count }, (_, index) => ({
    event: {
      occurred_at: new Date(startMs + Math.floor((index * span) / count) * dayMs + index * 1_000).toISOString(),
      played_ms: 200_000,
      event_type: "play_completed",
      extensions: {},
    },
    track: {
      track_ref_id: `${artist}:${index % 4}`,
      identity_status: "resolved",
      title: `Song ${index % 4}`,
      artist_credits: [{ name: artist, role: "primary" }],
    },
  }));
}

function history(byArtist) {
  const rows = Object.entries(byArtist).flatMap(([artist, years]) =>
    Object.entries(years).flatMap(([year, count]) => plays(artist, Number(year), count)));
  return rows.sort((left, right) => left.event.occurred_at.localeCompare(right.event.occurred_at));
}

// Fictional listening, 2019 to mid-2025, with a steady backdrop so each year
// holds enough plays to count.
const fixture = history({
  Backdrop: { 2019: 400, 2020: 400, 2021: 400, 2022: 400, 2023: 400, 2024: 400, 2025: 180 },
  "Fading Artist": { 2019: 500, 2020: 300, 2021: 150, 2022: 80, 2023: 40, 2024: 8, 2025: 2 },
  "Steady Artist": { 2019: 100, 2020: 110, 2021: 95, 2022: 100, 2023: 105, 2024: 100, 2025: 45 },
  "Returning Artist": { 2019: 60, 2020: 40, 2024: 30, 2025: 15 },
  "Burst Artist": { 2021: 200, 2022: 5, 2023: 3 },
  "Sparse Artist": { 2023: 5, 2024: 5 },
  "Recent Artist": { 2025: 30 },
  "Older Artist": { 2019: 30 },
});

function artists() {
  const { summary } = projectListeningProfile({ subjectId, eventRows: fixture, maxItems: 50 });
  return { summary, byName: new Map(summary.listening_behavior.enduring_artists.map((row) => [row.name, row])) };
}

test("each artist's yearly plays get a trajectory: fading, steady, returning, burst or unknown", () => {
  const { byName } = artists();
  assert.equal(byName.get("Fading Artist").trajectory, "fading");
  assert.equal(byName.get("Steady Artist").trajectory, "steady");
  assert.equal(byName.get("Returning Artist").trajectory, "returning");
  assert.equal(byName.get("Burst Artist").trajectory, "burst");
  assert.equal(byName.get("Sparse Artist").trajectory, "unknown");
  // A first year that is also the latest is new attention, not a trajectory.
  assert.equal(byName.get("Recent Artist").trajectory, "unknown");

  const fading = byName.get("Fading Artist");
  assert.deepEqual(fading.yearly_plays, [
    { year: 2019, plays: 500 }, { year: 2020, plays: 300 }, { year: 2021, plays: 150 },
    { year: 2022, plays: 80 }, { year: 2023, plays: 40 }, { year: 2024, plays: 8 }, { year: 2025, plays: 2 },
  ]);
  assert.equal(fading.first_played_at.slice(0, 4), "2019");
  // The returning artist's series keeps its gap visible: no entry for 2021 to 2023.
  assert.deepEqual(byName.get("Returning Artist").yearly_plays.map((item) => item.year), [2019, 2020, 2024, 2025]);
});

test("a rising artist is labelled rising, and a long series rolls its oldest years into one entry", () => {
  const years = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [2010 + index, index === 15 ? 100 : 400]));
  const rising = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [2010 + index, index < 13 ? 10 : 80]));
  const { summary } = projectListeningProfile({ subjectId, eventRows: history({ Backdrop: years, "Rising Artist": rising }) });
  const row = summary.listening_behavior.enduring_artists.find((item) => item.name === "Rising Artist");
  assert.equal(row.trajectory, "rising");
  assert.equal(row.yearly_plays.length, 13);
  assert.deepEqual(row.yearly_plays[0], { from_year: 2010, to_year: 2013, plays: 40 });
  assert.deepEqual(row.yearly_plays[1], { year: 2014, plays: 10 });
  assert.deepEqual(summary.listening_behavior.movement.rising.map((item) => item.name), ["Rising Artist"]);
});

function trajectories(rows) {
  rows.sort((left, right) => left.event.occurred_at.localeCompare(right.event.occurred_at));
  const { summary } = projectListeningProfile({ subjectId, eventRows: rows, maxItems: 50 });
  return { summary, of: (name) => summary.listening_behavior.enduring_artists.find((row) => row.name === name).trajectory };
}

test("a barely started latest year does not turn small steady artists into fading or rising ones", () => {
  const rows = [];
  for (let year = 2019; year <= 2024; year += 1) {
    rows.push(...spread("Backdrop", Date.UTC(year, 0, 1), 360, 1600));
    for (let index = 0; index < 4; index += 1) rows.push(...spread(`Small Steady ${index}`, Date.UTC(year, 0, 1), 360, 20));
  }
  // The history ends on 8 January, with one play or none for each small artist.
  rows.push(...spread("Backdrop", Date.UTC(2025, 0, 1), 8, 60));
  rows.push(...spread("Small Steady 0", Date.UTC(2025, 0, 1), 8, 1));
  rows.push(...spread("Small Steady 1", Date.UTC(2025, 0, 1), 8, 3));
  const { of } = trajectories(rows);
  for (let index = 0; index < 4; index += 1) assert.equal(of(`Small Steady ${index}`), "steady");
  assert.equal(of("Backdrop"), "steady");
});

test("a decline from 500 to 8 plays is fading, and a year with many more records does not make every artist a burst", () => {
  const decline = [];
  for (let year = 2021; year <= 2024; year += 1) decline.push(...spread("Backdrop", Date.UTC(year, 0, 1), 360, 1000));
  [500, 80, 20, 8].forEach((count, index) => decline.push(...spread("Decliner", Date.UTC(2021 + index, 0, 1), 360, count)));
  const declined = trajectories(decline);
  assert.equal(declined.of("Decliner"), "fading");
  assert.deepEqual(declined.summary.listening_behavior.movement.fading.map((item) => item.name), ["Decliner"]);

  // 2020 holds eight times the records of later years; each artist keeps the same share.
  const uneven = [];
  for (const [year, total] of [[2020, 8000], [2021, 1000], [2022, 1000], [2023, 1000]]) {
    uneven.push(...spread("Leader", Date.UTC(year, 0, 1), 360, total / 2));
    uneven.push(...spread("Constant", Date.UTC(year, 0, 1), 360, total / 4));
    uneven.push(...spread("Other", Date.UTC(year, 0, 1), 360, total / 4));
  }
  const { of } = trajectories(uneven);
  assert.deepEqual(["Leader", "Constant", "Other"].map(of), ["steady", "steady", "steady"]);
});

test("an artist fading by year but played heavily in the last ninety days is returning, not fading", () => {
  const rows = [];
  for (let year = 2019; year <= 2024; year += 1) rows.push(...spread("Backdrop", Date.UTC(year, 0, 1), 360, 1000));
  for (let year = 2019; year <= 2023; year += 1) rows.push(...spread("Comeback", Date.UTC(year, 0, 1), 360, 150));
  rows.push(...spread("Comeback", Date.UTC(2024, 10, 15), 45, 40));
  // 2025 holds too few plays to count as a year.
  rows.push(...spread("Backdrop", Date.UTC(2025, 0, 1), 20, 10));
  rows.push(...spread("Comeback", Date.UTC(2025, 0, 1), 20, 30));
  const { of, summary } = trajectories(rows);
  assert.equal(of("Comeback"), "returning");
  assert.equal(summary.listening_behavior.recent_artists[1].name, "Comeback");
  assert.deepEqual(summary.listening_behavior.movement.fading, []);
});

test("activation ranks a recently played artist above an equally played older one, read at the history's end", () => {
  const { byName, summary } = artists();
  const recent = byName.get("Recent Artist");
  const older = byName.get("Older Artist");
  assert.equal(recent.play_count, older.play_count);
  assert.ok(recent.activation > older.activation);
  assert.equal(typeof recent.activation, "number");
  // The view lists fading and returning artists without scanning every row.
  assert.deepEqual(summary.listening_behavior.movement.fading.map((item) => item.name), ["Fading Artist"]);
  assert.deepEqual(summary.listening_behavior.movement.returning.map((item) => item.name), ["Returning Artist"]);
  // Recent rows cover ninety days, so they carry no movement.
  assert.equal(summary.listening_behavior.recent_artists[0].trajectory, undefined);
});

test("the dossier lists movement by label, fading and returning first, and Apple counts carry none", () => {
  const { summary } = projectListeningProfile({ subjectId, eventRows: fixture, maxItems: 50 });
  const input = createListenerProfileInput({ subjectId, evidenceRevision: "fictional-movement",
    listening: { coverage: summary.coverage, sections: { history_artists: summary.listening_behavior.enduring_artists } },
    apple: { sections: { apple_artists: [{ name: "Library Giant", library_tracks: 40, play_count: 900, tracks_with_play_count: 40 }] } } });
  const dossier = listenerProfileDossier(input);
  assert.deepEqual(Object.keys(dossier.movement).filter((key) => key !== "note"), ["fading", "returning", "rising", "burst"]);
  assert.deepEqual(dossier.movement.fading.map((item) => item.name), ["Fading Artist"]);
  assert.deepEqual(dossier.movement.returning.map((item) => item.name), ["Returning Artist"]);
  assert.ok(input.evidence.has(dossier.movement.fading[0].ref));
  assert.equal(dossier.movement.fading[0].yearly_plays.length, 7);
  const fading = dossier.lifetime_artists.find((row) => row.name === "Fading Artist");
  assert.equal(fading.trajectory, "fading");
  assert.equal(fading.yearly_plays.length, 7);
  assert.equal(typeof fading.activation, "number");
  // An Apple library count is not dated plays: no series, no label.
  const apple = dossier.apple_artists[0];
  assert.equal(apple.name, "Library Giant");
  assert.equal(apple.trajectory, undefined);
  assert.equal(apple.yearly_plays, undefined);
  assert.ok(!JSON.stringify(dossier.movement).includes("Library Giant"));
  assert.equal(modelEvidence([...input.evidence.values()].find((entry) => entry.data.name === "Fading Artist"), 0, 2)
    .data.yearly_plays.length, 7);
});

test("profile exploration filters history artists by trajectory", () => {
  const { summary } = projectListeningProfile({ subjectId, eventRows: fixture, maxItems: 50 });
  const listening = { coverage: summary.coverage, sections: { history_artists: summary.listening_behavior.enduring_artists } };
  const page = exploreProfileCatalog({ listening, input: { section: "history_artists", trajectory: "fading" } });
  assert.deepEqual(page.items.map((item) => item.name), ["Fading Artist"]);
  assert.equal(page.matched, 1);
  assert.match(page.section_note, /yearly plays/u);
  assert.throws(() => profileExplorationInput({ section: "apple_artists", trajectory: "fading" }), /history artists/u);
  assert.throws(() => profileExplorationInput({ section: "history_artists", trajectory: "loved" }), /invalid/u);
});

test("the agent sees movement in the profile summary and can ask for fading artists", async (t) => {
  const store = await openEphemeralListeningHistoryStore();
  const services = createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId });
  t.after(() => services.close());
  const names = [...new Set(fixture.map((row) => row.track.artist_credits[0].name))];
  const records = fixture.map((row) => {
    const artist = row.track.artist_credits[0].name;
    return {
      ts: row.event.occurred_at, ms_played: 200_000, master_metadata_track_name: row.track.title,
      master_metadata_album_artist_name: artist, master_metadata_album_album_name: "Fixture album",
      spotify_track_uri: `spotify:track:${String(names.indexOf(artist) * 10 + Number(row.track.track_ref_id.at(-1))).padStart(22, "0")}`,
      incognito_mode: false, skipped: false, shuffle: false, offline: false,
    };
  });
  store.ingestImport(projectSpotifyExtendedStreamingHistory({ subjectId, records, capturedAt: "2025-07-01T00:00:00Z",
    archiveSha256: "c".repeat(64), archiveSizeBytes: 1000, memberNames: ["Streaming_History_Audio_2025.json"] }));
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
      fauxToolCall("moondog_profile_summary", { max_items: 10 }),
      fauxToolCall("moondog_profile_explore", { section: "history_artists", trajectory: "fading" }),
    ], { stopReason: "toolUse" }),
    (context) => {
      const [profile] = results(context, "moondog_profile_summary");
      const [page] = results(context, "moondog_profile_explore");
      const movement = profile.listening_behavior.movement;
      assert.match(movement.note, /not liking/u);
      assert.deepEqual(movement.fading.map((item) => item.name), ["Fading Artist"]);
      assert.deepEqual(movement.returning.map((item) => item.name), ["Returning Artist"]);
      assert.equal(movement.fading[0].yearly_plays.at(-1).year, 2025);
      const leader = profile.listening_behavior.enduring_artists.find((item) => item.name === "Fading Artist");
      assert.equal(leader.trajectory, "fading");
      assert.equal(typeof leader.activation, "number");
      assert.equal(leader.yearly_plays, undefined);
      assert.deepEqual(page.items.map((item) => [item.name, item.trajectory]), [["Fading Artist", "fading"]]);
      assert.equal(page.items[0].yearly_plays[0].plays, 500);
      assert.doesNotMatch(JSON.stringify([profile, page]), /spotify:track:/u);
      return fauxAssistantMessage([fauxText("Fading Artist has faded from your plays.")]);
    },
  ]);
  const result = await runtime.prompt("How has my listening moved over the years?");
  assert.equal(result.text, "Fading Artist has faded from your plays.");
});
