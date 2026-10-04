import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { compileListenerProfile, createListenerProfileInput, LISTENER_PROFILE_SYNTHESIS_VERSION, profileDigest,
  readListenerProfile, validateProfileReview } from "../../src/profile/listener-profile-build.mjs";
import { listenerProfileSchema, ListenerProfileStore } from "../../src/profile/listener-profile-store.mjs";
import { runListenerProfileBuild } from "../../src/profile/listener-profile-worker.mjs";
import { runListenerProfileCommand } from "../../src/surfaces/cli/listener-profile-command.mjs";
import { ProfileBuildRuntime } from "../../src/runtime/pi/profile-build-runtime.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";

function note(id, statement) {
  return { claim_id: id, kind: "observation", statement, scope: "Fictional imported evidence",
    uncertainty: "A collection record does not establish listening frequency.", supporting_refs: [], contradicting_refs: [] };
}

test("the default saved reading shows selected conclusions with their original explanation numbers", async () => {
  const claims = [note("first", "A peripheral collection row."), note("important", "A supported change in recent listening.")];
  const revision = { revision_id: "fixture-revision", sequence: 1, input_digest: "fixture-input",
    built_at: "2026-10-04T00:00:00Z", summary: "A fictional saved profile.",
    claims, highlight_claim_ids: ["important"], coverage: { reviewed_partitions: 2, digest_partitions: 2 } };
  const application = { getListenerProfile: async args => readListenerProfile({
    input: { input_digest: revision.input_digest }, store: { current: () => revision, revision: () => revision },
  }, args) };
  let output = "";
  await runListenerProfileCommand({ application, args: ["saved"], output: { write: value => { output += value; } } });
  assert.match(output, /2\. \[observation\] A supported change in recent listening/u);
  assert.doesNotMatch(output, /A peripheral collection row/u);
  output = "";
  await runListenerProfileCommand({ application, args: ["saved", "0"], output: { write: value => { output += value; } } });
  assert.match(output, /1\. \[observation\] A peripheral collection row/u);
});

test("the model receives collection ordering before it can infer chronology from page position", () => {
  const input = createListenerProfileInput({ subjectId, evidenceRevision: "fictional",
    listening: { sections: { saved_tracks: [{ label: "More played", listening_minutes: 50 },
      { label: "Less played", listening_minutes: 1 }] } } });
  const description = input.manifest.sections.find(section => section.section === "saved_tracks");
  assert.match(description.ordering ?? "", /listening.*descending/iu);
  assert.match(description.limitations ?? "", /not.*(save|add|chronolog)/iu);
});

test("page review ends before a separate final synthesis session", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new ProfileBuildRuntime({ models, model: faux.getModel(), provider: "faux", modelId: "fixture" });
  let reviewed = false;
  let requests = 0;
  const session = { phase: "review", manifest: {},
    progress: () => ({ reviewed_partitions: Number(reviewed), total_partitions: 1, pending: reviewed ? [] : [{ partition_id: "page" }] }),
    findings: () => ({ items: [], total: 0, offset: 0, next_offset: null }),
    review: () => { reviewed = true; return { saved_claims: [] }; },
    read: () => ({}), evidence: () => ({}), submit: () => { throw new Error("Review must not submit the final profile"); } };
  faux.setResponses([context => {
    requests++;
    assert.ok(!JSON.stringify(context.messages).includes("moondog_submit_listener_profile"), "final submission is unavailable during page review");
    return fauxAssistantMessage([fauxToolCall("moondog_record_profile_findings", {
      partition_id: "page", note: "No useful finding from this fictional page.", claims: [],
    })], { stopReason: "toolUse" });
  }]);
  try { await runtime.investigate(session); }
  finally { runtime.abort(); }
  assert.equal(requests, 1);
  assert.equal(reviewed, true);
});

test("a completed legacy reading reuses its pages for a fresh cross-source synthesis and keeps v1 intact", async t => {
  const sections = {
    history_artists: [{ name: "Lifetime leader", listening_minutes: 800 }],
    recent_artists: [{ name: "Recent leader", listening_minutes: 300 }],
    history_years: [{ year: 2025, event_count: 400, top_artist: { name: "Lifetime leader", listening_minutes: 600 } },
      { year: 2026, event_count: 200, top_artist: { name: "Recent leader", listening_minutes: 300 } }],
    listener_preferences: [{ label: "Explicit choice", correction_id: "fixture-choice", entity_type: "artist" }],
    saved_tracks: Array.from({ length: 80 }, (_, index) => ({ label: `Collection ${index}`, artist_credit: "Curated artist" })),
  };
  const input = createListenerProfileInput({ subjectId, evidenceRevision: "fixture", listening: { sections } });
  const legacy = structuredClone(input);
  legacy.manifest.sections = legacy.manifest.sections.map(({ section, rows }) => ({ section, rows }));
  legacy.input_digest = profileDigest({ subjectId, evidenceRevision: "fixture", manifest: legacy.manifest, partitions: legacy.partitions });
  assert.notEqual(legacy.input_digest, input.input_digest);
  assert.deepEqual(legacy.partitions, input.partitions, "new synthesis metadata must not discard completed page work");
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(listenerProfileSchema);
  const store = new ListenerProfileStore(database, subjectId);
  const model = { provider: "faux", model: "fixture", worker_version: "profile-investigation/1" };
  const oldBuild = store.begin(legacy, model);
  for (const part of legacy.partitions) {
    if (oldBuild.reviews[part.partition_id]) continue;
    const entry = part.items[0];
    store.checkpoint(oldBuild, validateProfileReview(legacy, part.partition_id, { note: "An earlier page observation.", claims: [{
      kind: "observation", statement: `${entry.data.name ?? entry.data.label ?? entry.data.year} is present.`,
      scope: part.section, uncertainty: "Presence is not liking.", supporting_refs: [entry.reference_id], contradicting_refs: [],
    }] }));
  }
  const oldClaims = Object.values(store.reviews(oldBuild.build_id)).flatMap(review => review.claims);
  const v1 = store.complete(oldBuild, { input_digest: legacy.input_digest, summary: "An earlier collection-heavy reading.",
    claims: oldClaims, highlight_claim_ids: [oldClaims.at(-1).claim_id],
    evidence: Object.fromEntries(legacy.evidence), coverage: { ...legacy.manifest, reviewed_partitions: legacy.partitions.length } });
  const application = { getProfileBuildContext: () => ({ input, store }),
    getListenerProfile: async args => readListenerProfile({ input, store }, args) };
  let sessions = 0;
  const result = await runListenerProfileBuild({ application, runtimeFactory: async () => ({
    publicStatus: () => ({ state: "configured", ...model }), abort() {},
    async investigate(session) {
      sessions++;
      assert.equal(session.phase, "synthesis");
      assert.equal(session.progress().pending.length, 0);
      const lifetime = session.overview.find(section => section.section === "history_artists").items[0];
      const recent = session.overview.find(section => section.section === "recent_artists").items[0];
      assert.equal(session.overview.find(section => section.section === "history_years").items.length, 2);
      assert.equal(session.overview.find(section => section.section === "listener_preferences").items[0].data.label, "Explicit choice");
      assert.equal(session.findings(0, { section: "saved_tracks", query: "Collection 72" }).items.length, 1);
      assert.equal(session.findings(0, { section: "history_artists", query: "Curated artist" }).total, 0);
      assert.throws(() => session.review(input.partitions[0].partition_id, {}), /fixed during final synthesis/u);
      assert.throws(() => session.submit({ summary: "Unsupported.", insights: [{ ...note("invalid", "No support"), supporting_refs: ["missing"] }] }), /evidence reference/u);
      session.submit({ summary: "Lifetime and recent attention have different leaders; the years and collection need separate interpretation.",
        insights: [{ kind: "observation", statement: "The recent leader differs from the lifetime leader.",
          scope: "Imported lifetime and recent listening windows.", uncertainty: "Different observation windows overlap and do not establish permanent liking.",
          supporting_refs: [lifetime.reference_id, recent.reference_id], contradicting_refs: [] }] });
    },
  }) });
  assert.equal(sessions, 1);
  assert.equal(result.reused_partitions, input.partitions.length - 1);
  assert.equal(result.revision.sequence, 2);
  assert.equal(result.revision.parent_revision_id, v1.revision_id);
  assert.equal(store.current().synthesis_version, LISTENER_PROFILE_SYNTHESIS_VERSION);
  assert.equal(result.revision.highlights.length, 1);
  assert.equal(result.revision.listener_assertions[0].statement, "Explicit choice: explicit positive choice.");
  assert.deepEqual(store.revision(v1.revision_id), v1);
  assert.ok(oldClaims.every(claim => store.current().claims.some(saved => saved.claim_id === claim.claim_id)));
  const highlight = result.revision.highlights[0];
  const detail = await application.getListenerProfile({ claimId: highlight.claim_id });
  assert.deepEqual(detail.supporting_evidence.map(entry => entry.section), ["history_artists", "recent_artists"]);
  assert.equal((await runListenerProfileBuild({ application, runtimeFactory: () => { throw new Error("Already current"); } })).state, "unchanged");
});

test("final synthesis cannot mint a listener assertion or save before page coverage is complete", () => {
  const input = createListenerProfileInput({ subjectId, evidenceRevision: "fixture", listening: {
    sections: { saved_tracks: [{ label: "Fictional remix" }] } } });
  const part = input.partitions[0];
  const insight = { kind: "listener_assertion", statement: "This remix is a favorite.", scope: "Library", uncertainty: "None.",
    supporting_refs: [part.items[0].reference_id], contradicting_refs: [] };
  assert.throws(() => compileListenerProfile(input, {}, { summary: "Premature", insights: [insight] }), /Review every/u);
  assert.throws(() => compileListenerProfile(input, { [part.partition_id]: { claims: [] } },
    { summary: "Invented preference", insights: [insight] }), /Only the listener/u);
});
