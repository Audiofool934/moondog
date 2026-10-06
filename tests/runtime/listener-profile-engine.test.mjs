import assert from "node:assert/strict";
import test from "node:test";
import { compileListenerProfile, createListenerProfileInput, listenerProfileDossier, readListenerProfile }
  from "../../src/profile/listener-profile-build.mjs";
import { listenerProfileCandidate, searchListenerProfileEvidence, validateListenerProfileCheck }
  from "../../src/profile/listener-profile-verification.mjs";
import { runListenerProfileCommand } from "../../src/surfaces/cli/listener-profile-command.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";

function input() {
  return createListenerProfileInput({ subjectId, evidenceRevision: "fictional-engine", listening: {
    context: { reference_date: "2026-08-30T00:00:00.000Z", recent_window_days: 90 },
    coverage: { effective_listening_events: 300, earliest_played_at: "2024-01-02T00:00:00.000Z", latest_played_at: "2026-08-30T00:00:00.000Z" },
    sections: {
      history_artists: Array.from({ length: 90 }, (_, index) => ({ name: `Artist ${index + 1}`, play_count: 200 - index,
        listening_minutes: 900 - index * 9, distinct_tracks: 5, evidence_id: `private-${index}`, track_ref_id: "private" })),
      recent_artists: [{ name: "Artist 60", play_count: 40, listening_minutes: 120 }, { name: "Newcomer", play_count: 12, listening_minutes: 30 }],
      followed_artists: [{ name: "Shelf Composer", source_label: "Fictional service" }, { name: "Artist 1", source_label: "Fictional service" }],
      saved_albums: [{ label: "Night Scores", artist_credit: "Shelf Composer" }],
      provider_evidence: [
        { evidence_kind: "library_track_saved", label: "Duplicate of a saved track" },
        { evidence_kind: "wrapped_artist_ranked", label: "Artist 1", rank: 1, period: "2025" },
      ],
      listener_preferences: [{ label: "Artist 2", entity_type: "artist", stance: "like", correction_id: "private-choice" }],
    },
  } });
}

test("the dossier shows leaders, recent movement, curated interests beyond listening and every choice, without private identifiers", () => {
  const value = input();
  const dossier = listenerProfileDossier(value);
  assert.equal(dossier.lifetime_artists.length, 40);
  assert.equal(dossier.lifetime_artists[0].name, "Artist 1");
  assert.ok(value.evidence.has(dossier.lifetime_artists[0].ref));
  assert.equal(dossier.next_lifetime_artists.length, 40);
  assert.deepEqual(dossier.recent_artists.map(row => [row.name, row.lifetime_rank]), [["Artist 60", 60], ["Newcomer", null]]);
  assert.equal(dossier.curated_beyond_listening.length, 1);
  assert.equal(dossier.curated_beyond_listening[0].artist, "Shelf Composer");
  assert.deepEqual(dossier.curated_beyond_listening[0].signals, ["followed", "saved album Night Scores"]);
  assert.deepEqual(dossier.provider_signals.map(row => row.evidence_kind), ["wrapped_artist_ranked"]);
  assert.equal(dossier.explicit_choices[0].label, "Artist 2");
  assert.match(dossier.sections.history_artists.ordering, /duration/u);
  assert.doesNotMatch(JSON.stringify(dossier), /private-|track_ref_id|evidence_id|correction_id/u);
});

test("only the listener's records become choices, and every finding cites known evidence", () => {
  const value = input();
  const ref = [...value.evidence.keys()][0];
  const finding = { kind: "hypothesis", statement: "A fictional reading.", scope: "Lifetime listening.",
    uncertainty: "A fixture.", supporting_refs: [ref], contradicting_refs: [] };
  const profile = compileListenerProfile(value, { summary: "A fictional summary.", insights: [finding] });
  assert.deepEqual(profile.claims.map(claim => claim.kind), ["hypothesis", "listener_assertion"]);
  assert.deepEqual(profile.highlight_claim_ids, [profile.claims[0].claim_id]);
  assert.throws(() => compileListenerProfile(value, { summary: "Empty.", insights: [] }), /one to twelve/u);
  assert.throws(() => compileListenerProfile(value, { summary: "Invented.", insights: [{ ...finding, kind: "listener_assertion" }] }), /Only the listener/u);
  assert.throws(() => compileListenerProfile(value, { summary: "Unknown.", insights: [{ ...finding, supporting_refs: ["ev_unknown"] }] }), /unknown IDs/u);
});

test("the check judges one exact candidate with a verdict and at most six material issues", () => {
  const value = input();
  const ref = [...value.evidence.keys()][0];
  const candidate = listenerProfileCandidate(value, compileListenerProfile(value, { summary: "A fictional summary.", insights: [
    { kind: "observation", statement: "Artist 1 leads.", scope: "Lifetime.", uncertainty: "A fixture.", supporting_refs: [ref], contradicting_refs: [] },
  ] }));
  const claimId = candidate.insights[0].claim_id;
  const issue = { target: claimId, problem: "Wrong leader.", correction: "Name the measured leader." };
  assert.equal(validateListenerProfileCheck(candidate, { candidate_id: candidate.candidate_id, verdict: "pass", issues: [] }).verdict, "pass");
  assert.deepEqual(validateListenerProfileCheck(candidate, { candidate_id: candidate.candidate_id, verdict: "revise", issues: [issue] }).issues, [issue]);
  for (const [check, message] of [
    [{ candidate_id: "other", verdict: "pass", issues: [] }, /current profile candidate/u],
    [{ candidate_id: candidate.candidate_id, verdict: "revise", issues: [] }, /at least one material issue/u],
    [{ candidate_id: candidate.candidate_id, verdict: "pass", issues: [issue] }, /lists no issues/u],
    [{ candidate_id: candidate.candidate_id, verdict: "revise", issues: [{ ...issue, target: "coverage" }] }, /must be "summary" or a claim_id/u],
    [{ candidate_id: candidate.candidate_id, verdict: "revise", issues: Array(7).fill(issue) }, /at most 6/u],
    [{ candidate_id: candidate.candidate_id, verdict: "maybe", issues: [] }, /pass or revise/u],
  ]) assert.throws(() => validateListenerProfileCheck(candidate, check), message);
});

test("the model receives collection ordering before it can infer chronology from row position", () => {
  const value = createListenerProfileInput({ subjectId, evidenceRevision: "fictional",
    listening: { sections: { saved_tracks: [{ label: "More played", listening_minutes: 50 },
      { label: "Less played", listening_minutes: 1 }] } } });
  const description = value.manifest.sections.find(section => section.section === "saved_tracks");
  assert.match(description.ordering ?? "", /listening.*descending/iu);
  assert.match(description.limitations ?? "", /not.*(save|add|chronolog)/iu);
});

test("evidence search reaches rows beyond the dossier and values beyond the first continuation", () => {
  const value = createListenerProfileInput({ subjectId, evidenceRevision: "long-field", listening: { sections: {
    playlist_tracks: Array.from({ length: 40 }, (_, index) => ({ label: `Song ${index}`,
      playlist_names: Array.from({ length: 25 }, (_, number) => `Collection ${number}`),
      provider_handle: "PRIVATE_NOT_SEARCHABLE" })),
  } } });
  const page = searchListenerProfileEvidence(value, { query: "collection 24" });
  assert.equal(page.total, 40);
  assert.equal(page.items.length, 12);
  assert.equal(page.next_offset, 12);
  assert.equal(page.items[0].continuations.playlist_names.next_offset, 12);
  assert.equal(searchListenerProfileEvidence(value, { query: "collection 24", offset: 36 }).next_offset, null);
  assert.equal(searchListenerProfileEvidence(value, { query: "PRIVATE_NOT_SEARCHABLE" }).total, 0);
  assert.equal(searchListenerProfileEvidence(value, { query: "Song 39" }).items[0].data.label, "Song 39");
});

test("an older saved reading stays readable and is marked for an update", async () => {
  const claims = [{ claim_id: "first", kind: "observation", statement: "A page note from an earlier engine.", scope: "Fixture",
    uncertainty: "Old.", supporting_refs: [], contradicting_refs: [] },
  { claim_id: "important", kind: "observation", statement: "An earlier highlight.", scope: "Fixture",
    uncertainty: "Old.", supporting_refs: [], contradicting_refs: [] }];
  const revision = { revision_id: "legacy", sequence: 1, input_digest: "fixture-input", synthesis_version: "listener-synthesis/3",
    built_at: "2026-10-04T00:00:00Z", summary: "An earlier reading.", verification: { state: "passed" },
    claims, highlight_claim_ids: ["important"], coverage: { reviewed_partitions: 2, digest_partitions: 2 } };
  const application = { getListenerProfile: async args => readListenerProfile({
    input: { input_digest: revision.input_digest }, store: { current: () => revision, revision: () => revision },
  }, args) };
  let output = "";
  await runListenerProfileCommand({ application, args: ["saved"], output: { write: text => { output += text; } } });
  assert.match(output, /Evidence, choices or analysis changed/u);
  assert.match(output, /2\. An earlier highlight\./u);
  assert.doesNotMatch(output, /A page note from an earlier engine/u);
  assert.match(output, /All 2 findings: moondog profile saved 0/u);
});
