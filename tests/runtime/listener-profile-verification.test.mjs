import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createListenerProfileInput, readListenerProfile } from "../../src/profile/listener-profile-build.mjs";
import { ListenerProfileStore, listenerProfileSchema } from "../../src/profile/listener-profile-store.mjs";
import { runListenerProfileBuild } from "../../src/profile/listener-profile-worker.mjs";
import { listenerProfileVerificationBatch, searchListenerProfileEvidence } from "../../src/profile/listener-profile-verification.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";
const model = { provider: "faux", model: "fixture", worker_version: "profile-investigation/1" };

function fixture(t) {
  const input = createListenerProfileInput({ subjectId, evidenceRevision: "fictional-verification",
    listening: { sections: {
      history_artists: [{ name: "Glass Orchard", play_count: 12, listening_minutes: 80 }],
      followed_artists: [{ name: "Glass Orchard", source_label: "Fictional service" }],
    } } });
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(listenerProfileSchema);
  const store = new ListenerProfileStore(database, subjectId);
  const application = { getProfileBuildContext: () => ({ input, store }),
    getListenerProfile: async args => readListenerProfile({ input, store }, args) };
  const refs = Object.fromEntries([...input.evidence.values()].map(entry => [entry.section, entry.reference_id]));
  const draft = correct => ({ summary: correct ? "Glass Orchard has 12 recorded plays and 80 listening minutes."
    : "Glass Orchard has 80 recorded plays, contradicted by following the artist.",
  insights: [{ kind: "observation", statement: correct ? "Glass Orchard has 12 recorded plays and 80 listening minutes."
    : "Glass Orchard has 80 recorded plays, contradicted by following the artist.",
  scope: "Imported history and curation.", uncertainty: "These records do not rank subjective importance.",
  supporting_refs: [refs.history_artists], contradicting_refs: correct ? [] : [refs.followed_artists] }] });
  return { input, database, store, application, refs, draft };
}

function reviewPages(session) {
  for (const pending of session.progress().pending) {
    const page = session.read(pending.partition_id);
    session.review(page.partition_id, { note: "Inspected the fictional source.", claims: [] });
  }
}

function report(session, { revise = false } = {}) {
  return { candidate_id: session.candidate.candidate_id,
    checks: ["summary", "coverage", ...session.candidate.insights.map(claim => claim.claim_id)].map(target => ({
      target, status: revise && target !== "coverage" ? "revise" : "supported",
      reason: revise && target !== "coverage" ? "80 is minutes, not plays; following the artist is not a counterexample."
        : "The scoped statement agrees with the measured record and preserves the supported interest.",
      evidence_refs: [...session.candidate.insights[0].supporting_refs, ...session.candidate.insights[0].contradicting_refs],
    })) };
}

const runtime = investigate => async () => ({ publicStatus: () => ({ state: "configured", ...model }),
  investigate, abort() {} });

test("one build repairs valid references that do not support the claimed metric or counterexample", async t => {
  const f = fixture(t);
  const phases = [];
  let reviewedPages = 0;
  const result = await runListenerProfileBuild({ application: f.application, runtimeFactory: runtime(async session => {
    phases.push(session.phase);
    if (session.phase === "review") { reviewedPages += session.progress().pending.length; reviewPages(session); }
    else if (session.phase === "synthesis") session.submit(f.draft(false));
    else if (session.phase === "verification") {
      assert.equal(f.store.current(), null, "an unchecked candidate must not become the current reading");
      session.verify(report(session, { revise: session.candidate.summary.includes("80 recorded plays") }));
    } else if (session.phase === "repair") {
      assert.ok(session.verification.checks.some(check => check.status === "revise"));
      assert.equal(session.search({ section: "history_artists", query: "Glass Orchard" }).items[0].data.play_count, 12);
      session.submit(f.draft(true));
    }
  }) });
  assert.equal(result.revision.summary, f.draft(true).summary);
  assert.deepEqual(phases, ["review", "synthesis", "verification", "repair", "verification"]);
  assert.equal(reviewedPages, f.input.partitions.length);
  assert.equal(result.revision.verification.repair_count, 1);
  assert.equal(result.revision.verification.state, "passed");
  assert.equal(result.revision.highlights[0].contradicting_refs.length, 0);
});

test("verification must cover the exact candidate before it can be saved", async t => {
  const f = fixture(t);
  await assert.rejects(runListenerProfileBuild({ application: f.application, runtimeFactory: runtime(async session => {
    if (session.phase === "review") reviewPages(session);
    else if (session.phase === "synthesis") session.submit(f.draft(true));
    else if (session.phase === "verification") {
      const complete = report(session);
      assert.throws(() => session.verify({ ...complete, candidate_id: "earlier-candidate" }), /candidate/u);
      assert.throws(() => session.verify({ ...complete, checks: [] }), /every/u);
      assert.throws(() => session.verify({ ...complete, checks: [...complete.checks, complete.checks[0]] }), /every/u);
      const missingClaim = session.candidate.insights[0];
      assert.throws(() => session.verify({ ...complete,
        checks: complete.checks.map(check => ({ ...check, evidence_refs: [] })) }), error =>
        error.message.includes(missingClaim.claim_id) && error.message.includes(missingClaim.supporting_refs[0]));
      assert.throws(() => session.submit(f.draft(false)), /synthesis or repair/u);
      session.verify({ ...complete, checks: complete.checks.slice(1) });
      assert.equal(session.verification.state, "checking", "partial checks never approve a candidate");
      assert.equal(f.store.current(), null);
      throw new Error("Verification did not finish");
    }
  }) }), /Verification did not finish/u);
  assert.equal(f.store.current(), null);
});

test("focused checking resumes only unfinished targets after interruption", async t => {
  const f = fixture(t);
  const controller = new AbortController();
  let checkedClaim;
  await assert.rejects(runListenerProfileBuild({ application: f.application, signal: controller.signal,
    runtimeFactory: runtime(async session => {
      if (session.phase === "review") reviewPages(session);
      else if (session.phase === "synthesis") session.submit(f.draft(true));
      else {
        const batch = listenerProfileVerificationBatch(session.candidate, session.verification);
        checkedClaim = session.candidate.insights[0].claim_id;
        assert.deepEqual(batch.targets, [checkedClaim]);
        assert.equal(batch.candidate.summary, undefined);
        assert.equal(batch.candidate.cited_evidence.length, 1);
        const complete = report(session);
        session.verify({ ...complete, checks: complete.checks.filter(check => batch.targets.includes(check.target)) });
        assert.equal(session.verification.state, "checking");
        controller.abort();
      }
    }) }), { name: "AbortError" });
  assert.equal(f.store.current(), null);
  const built = await runListenerProfileBuild({ application: f.application, runtimeFactory: runtime(async session => {
    assert.equal(session.phase, "verification");
    assert.deepEqual(session.verification.checks.map(check => check.target), [checkedClaim]);
    const batch = listenerProfileVerificationBatch(session.candidate, session.verification);
    assert.deepEqual(batch.targets, ["summary", "coverage"]);
    assert.equal(batch.candidate.summary, f.draft(true).summary);
    const complete = report(session);
    assert.throws(() => session.verify(complete), /exactly once/u);
    session.verify({ ...complete, checks: complete.checks.filter(check => batch.targets.includes(check.target)) });
  }) });
  assert.equal(built.revision.verification.state, "passed");
  assert.equal(built.revision.verification.attempts, 1);
});

test("targeted repairs preserve passed claims and reuse only unchanged claim checks", async t => {
  const f = fixture(t);
  const kept = { kind: "observation", statement: "The imported curation includes a follow of Glass Orchard.",
    scope: "Fictional curation.", uncertainty: "A follow does not rank subjective importance.",
    supporting_refs: [f.refs.followed_artists], contradicting_refs: [] };
  let originalKept;
  let checks = 0;
  const result = await runListenerProfileBuild({ application: f.application, runtimeFactory: runtime(async session => {
    if (session.phase === "review") reviewPages(session);
    else if (session.phase === "synthesis") {
      const value = f.draft(false);
      session.submit({ ...value, insights: [...value.insights, kept] });
      originalKept = structuredClone(session.candidate.insights[1]);
    } else if (session.phase === "repair") {
      assert.throws(() => session.repair({ changes: [{ claim_id: originalKept.claim_id,
        replacement: { ...kept, statement: "An unrelated rewrite of a passed claim." } }] }), /only failed/u);
      assert.throws(() => session.repair({ changes: [], additions: [kept] }), /only failed/u);
      session.repair({ summary: f.draft(true).summary, changes: [{ claim_id: session.candidate.insights[0].claim_id,
        replacement: f.draft(true).insights[0] }] });
      assert.deepEqual(session.candidate.insights[1], originalKept);
      assert.deepEqual(session.verification.checks.map(check => check.target), [originalKept.claim_id]);
    } else {
      checks++;
      const checked = new Set(session.verification?.checks.map(check => check.target));
      session.verify({ candidate_id: session.candidate.candidate_id,
        checks: ["summary", "coverage", ...session.candidate.insights.map(claim => claim.claim_id)]
          .filter(target => !checked.has(target)).map(target => {
            const claim = session.candidate.insights.find(item => item.claim_id === target);
            return { target, status: checks === 1 && ["summary", session.candidate.insights[0].claim_id].includes(target)
              ? "revise" : "supported", reason: "Check the count and each reference role against the fictional source.",
            evidence_refs: claim ? [...claim.supporting_refs, ...claim.contradicting_refs] : [] };
          }) });
    }
  }) });
  assert.equal(checks, 2);
  assert.equal(result.revision.verification.reused_checks, 1);
  assert.equal(result.revision.verification.repair_count, 1);
  assert.deepEqual(result.revision.highlights[1], { ...originalKept,
    finding_number: result.revision.highlights[1].finding_number });
});

test("an interrupted draft resumes at verification without repeating synthesis or page work", async t => {
  const f = fixture(t);
  const controller = new AbortController();
  await assert.rejects(runListenerProfileBuild({ application: f.application, signal: controller.signal,
    runtimeFactory: runtime(async session => {
      if (session.phase === "review") reviewPages(session);
      else if (session.phase === "synthesis") { session.submit(f.draft(false)); controller.abort(); }
    }) }), { name: "AbortError" });
  assert.equal(f.store.current(), null);
  const reopened = new ListenerProfileStore(f.database, subjectId);
  const application = { getProfileBuildContext: () => ({ input: f.input, store: reopened }),
    getListenerProfile: async args => readListenerProfile({ input: f.input, store: reopened }, args) };
  const phases = [];
  const built = await runListenerProfileBuild({ application, runtimeFactory: runtime(async session => {
    phases.push(session.phase);
    if (session.phase === "verification") session.verify(report(session, { revise: session.candidate.summary.includes("80 recorded plays") }));
    else if (session.phase === "repair") session.submit(f.draft(true));
    else assert.fail("Page review and synthesis were already checkpointed");
  }) });
  assert.deepEqual(phases, ["verification", "repair", "verification"]);
  assert.equal(built.reused_partitions, f.input.partitions.length);
  assert.equal(built.revision.summary, f.draft(true).summary);
  assert.equal(built.revision.verification.attempts, 2);
});

test("automatic repair is bounded and failure preserves the previous profile and reusable checkpoints", async t => {
  const f = fixture(t);
  const oldBuild = f.store.begin(f.input, model);
  const previous = f.store.complete(oldBuild, { input_digest: f.input.input_digest, synthesis_version: "listener-synthesis/2",
    summary: "The previous saved reading.", claims: [], highlight_claim_ids: [], evidence: {},
    coverage: { ...f.input.manifest, reviewed_partitions: f.input.partitions.length } });
  let repairs = 0;
  let checks = 0;
  await assert.rejects(runListenerProfileBuild({ application: f.application, runtimeFactory: runtime(async session => {
    if (session.phase === "review") reviewPages(session);
    else if (session.phase === "verification") { checks++; session.verify(report(session, { revise: true })); }
    else { if (session.phase === "repair") repairs++; session.submit(f.draft(false)); }
  }) }), /two automatic repairs/u);
  assert.equal(repairs, 2);
  assert.equal(checks, 3);
  assert.deepEqual(f.store.current(), previous);
  const phases = [];
  const recovered = await runListenerProfileBuild({ application: f.application, runtimeFactory: runtime(async session => {
    phases.push(session.phase);
    if (session.phase === "repair") session.submit(f.draft(true));
    else if (session.phase === "verification") session.verify(report(session));
    else assert.fail("A retry must retain the failed draft and its reviewed evidence");
  }) });
  assert.deepEqual(phases, ["repair", "verification"]);
  assert.equal(recovered.revision.parent_revision_id, previous.revision_id);
  assert.equal(recovered.revision.verification.repair_count, 3);
  assert.deepEqual(f.store.revision(previous.revision_id), previous);
});

test("a passed check survives interruption before the atomic revision commit", async t => {
  const f = fixture(t);
  const controller = new AbortController();
  await assert.rejects(runListenerProfileBuild({ application: f.application, signal: controller.signal,
    onProgress: progress => { if (progress.phase === "complete") controller.abort(); },
    runtimeFactory: runtime(async session => {
      if (session.phase === "review") reviewPages(session);
      else if (session.phase === "synthesis") session.submit(f.draft(true));
      else session.verify(report(session));
    }) }), { name: "AbortError" });
  assert.equal(f.store.current(), null);
  const built = await runListenerProfileBuild({ application: f.application, runtimeFactory: runtime(async () => {
    assert.fail("A completed verification checkpoint should not call the model again");
  }) });
  assert.equal(built.revision.summary, f.draft(true).summary);
  assert.equal(built.revision.verification.attempts, 1);
});

test("raw evidence search includes unreviewed rows and values beyond the first continuation", () => {
  const input = createListenerProfileInput({ subjectId, evidenceRevision: "long-field", listening: { sections: {
    playlist_tracks: Array.from({ length: 40 }, (_, index) => ({ label: `Song ${index}`,
      playlist_names: Array.from({ length: 25 }, (_, number) => `Collection ${number}`),
      provider_handle: "PRIVATE_NOT_SEARCHABLE" })),
  } } });
  const page = searchListenerProfileEvidence(input, { query: "collection 24" });
  assert.equal(page.total, 40);
  assert.equal(page.items.length, 12);
  assert.equal(page.next_offset, 12);
  assert.equal(page.items[0].continuations.playlist_names.next_offset, 12);
  assert.equal(searchListenerProfileEvidence(input, { query: "collection 24", offset: 36 }).next_offset, null);
  assert.equal(searchListenerProfileEvidence(input, { query: "PRIVATE_NOT_SEARCHABLE" }).total, 0);
  assert.equal(searchListenerProfileEvidence(input, { query: "Song 39" }).items[0].data.label, "Song 39");
});
