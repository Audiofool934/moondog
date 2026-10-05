import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createListeningProfileDomainServices } from "../../src/core/listening-profile-domain-services.mjs";
import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";
import { createListenerProfileInput, validateProfileReview } from "../../src/profile/listener-profile-build.mjs";
import { projectSpotifyExtendedStreamingHistory } from "../../src/integrations/spotify/extended-streaming-history.mjs";
import { ProfileBuildRuntime } from "../../src/runtime/pi/profile-build-runtime.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";
import { runListenerProfileCommand } from "../../src/surfaces/cli/listener-profile-command.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";
const modelStatus = { state: "configured", provider: "faux", model: "faux-1", worker_version: "profile-investigation/1" };

function bundle(count = 141, digest = "a") {
  return projectSpotifyExtendedStreamingHistory({
    subjectId, capturedAt: "2026-09-01T00:00:00Z", archiveSha256: digest.repeat(64), archiveSizeBytes: 4096,
    memberNames: ["Streaming_History_Audio_2026.json"],
    records: Array.from({ length: count }, (_, index) => ({
      ts: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(), ms_played: index === 140 ? 60_000 : 180_000,
      master_metadata_track_name: index === 140 ? "Quiet interest" : `Fixture ${String(index).padStart(3, "0")}`,
      master_metadata_album_artist_name: index === 140 ? "Smaller artist" : "Dominant artist",
      master_metadata_album_album_name: "Fixture album", spotify_track_uri: `spotify:track:${String(index).padStart(22, "0")}`,
      incognito_mode: false, skipped: false, shuffle: false, offline: false,
    })),
  });
}

async function fixture(t, initial = bundle()) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-profile-build-"));
  const options = { databasePath: path.join(root, "listening-history.sqlite"), boundaryRoot: root };
  const state = { root };
  state.open = async () => {
    state.store = await openListeningHistoryStore(options);
    state.application = new MoondogApplication({
      domainServices: createListeningProfileDomainServices({ listeningHistoryStore: state.store, subjectId }),
      importsRoot: path.join(root, "no-imports"),
    });
  };
  await state.open();
  state.store.ingestImport(initial);
  t.after(async () => { await state.application.close(); await rm(root, { recursive: true, force: true }); });
  return state;
}

function finding(entry) {
  return {
    kind: "observation", statement: `${entry.data.label ?? entry.data.name ?? "This selection"} is present in the retained evidence.`,
    scope: entry.section, uncertainty: "Presence measures attention, not a confirmed preference.",
    supporting_refs: [entry.reference_id], contradicting_refs: [],
  };
}

function reviewPage(session, partitionId) {
  const page = session.read(partitionId);
  assert.doesNotMatch(JSON.stringify(page), /spotify:track:|subject_id|external_id|track_ref_id|correction_id/u);
  if (page.section === "history_releases") {
    assert.equal(page.items[0].data.title, "Fixture album");
    assert.equal(page.items[0].data.first_year, 2026);
  }
  const chosen = page.items.find(item => item.data.label === "Quiet interest") ?? page.items[0];
  return session.review(partitionId, { note: "Reviewed this evidence page and its scope.", claims: [finding(chosen)] });
}

function submit(session) {
  const claims = [];
  let offset = 0;
  do {
    const page = session.findings(offset);
    claims.push(...page.items);
    offset = page.next_offset;
  } while (offset !== null);
  const selected = [...claims.filter(claim => claim.statement.includes("Quiet interest")), ...claims]
    .filter(claim => claim.kind !== "listener_assertion").slice(0, 12);
  session.submit({ summary: "There is broad dominant attention and a smaller retained interest; explicit choices take precedence.",
    insights: [...new Map(selected.map(claim => [claim.claim_id, claim])).values()] });
}

function approve(session) {
  session.verify({ candidate_id: session.candidate.candidate_id, checks: [
    ...["summary", "coverage"].map(target => ({ target, status: "supported", reason: "Supported fictional overview.", evidence_refs: [] })),
    ...session.candidate.insights.map(claim => ({ target: claim.claim_id, status: "supported",
      reason: "The fictional observation matches its evidence.",
      evidence_refs: [...claim.supporting_refs, ...claim.contradicting_refs] })),
  ] });
}

function scriptedRuntime(investigate = async session => {
  while (session.progress().pending.length) for (const item of session.progress().pending) reviewPage(session, item.partition_id);
  if (session.phase === "synthesis") submit(session);
  else if (session.phase === "verification") approve(session);
}) {
  return async () => ({ publicStatus: () => modelStatus, investigate, abort() {} });
}

test("saved profile includes the tail, survives restart, reuses identical imports, and revises after a choice", async t => {
  const state = await fixture(t);
  const runtimeFactory = scriptedRuntime();
  const input = state.application.getProfileBuildContext().input;
  const tailPage = input.partitions.find(part => part.section === "history_tracks" && part.items.some(item => item.data.label === "Quiet interest"));
  assert.ok(tailPage.offset >= 100);
  const built = await state.application.buildListenerProfile({ runtimeFactory });
  assert.equal(built.state, "ready");
  assert.equal(built.revision.coverage.reviewed_partitions, input.partitions.length);
  const tail = built.revision.highlights.find(claim => claim.statement.includes("Quiet interest"));
  assert.ok(tail);
  const detail = await state.application.getListenerProfile({ claimId: tail.claim_id });
  assert.ok(detail.supporting_evidence.some(item => item.data.label === "Quiet interest"));
  await state.application.close();
  await state.open();
  assert.deepEqual(await state.application.getListenerProfile({ claimId: tail.claim_id }), detail);
  state.store.ingestImport(bundle());
  assert.equal((await state.application.buildListenerProfile({ runtimeFactory: () => { throw new Error("model must not run"); } })).state, "unchanged");

  state.store.recordListenerCorrection({ subjectId, entityType: "artist", label: "Smaller artist", stance: "avoid" });
  assert.equal((await state.application.getListenerProfile()).state, "stale");
  const next = await state.application.buildListenerProfile({ runtimeFactory });
  assert.equal(next.revision.sequence, 2);
  assert.equal(next.revision.parent_revision_id, built.revision.revision_id);
  assert.ok(next.revision.listener_assertions.some(claim => claim.kind === "listener_assertion" && claim.stance === "avoid" && /Smaller artist/u.test(claim.statement)));
  assert.equal((await state.application.getListenerProfile({ revisionId: built.revision.revision_id })).state, "stale");

  let output = "";
  await runListenerProfileCommand({ application: state.application, args: ["saved"], output: { write: text => { output += text; } } });
  assert.match(output, /saved listening profile · v2/u);
  output = "";
  await runListenerProfileCommand({ application: state.application, args: ["explain", "1"], output: { write: text => { output += text; } } });
  assert.match(output, /Supporting evidence:/u);
  assert.doesNotMatch(output, /subject_id|spotify:track:|track_ref_id/u);
});

test("interrupted builds checkpoint pages, resume after restart, and keep the previous usable revision", async t => {
  const state = await fixture(t, bundle(3));
  const first = await state.application.buildListenerProfile({ runtimeFactory: scriptedRuntime() });
  state.store.recordListenerCorrection({ subjectId, entityType: "artist", label: "Dominant artist", stance: "like" });
  const controller = new AbortController();
  let sessions = 0;
  await assert.rejects(state.application.buildListenerProfile({ signal: controller.signal, runtimeFactory: scriptedRuntime(async session => {
    reviewPage(session, session.progress().pending[0].partition_id);
    if (++sessions === 2) controller.abort();
  }) }), { name: "AbortError" });
  assert.equal(sessions, 2);
  assert.equal((await state.application.getListenerProfile()).revision_id, first.revision.revision_id);
  await state.application.close();
  await state.open();
  let resumed;
  const final = await state.application.buildListenerProfile({ runtimeFactory: scriptedRuntime(async session => {
    resumed = session.progress();
    while (session.progress().pending.length) for (const part of session.progress().pending) reviewPage(session, part.partition_id);
    if (session.phase === "synthesis") submit(session);
    else if (session.phase === "verification") approve(session);
  }) });
  assert.ok(resumed.reused_partitions > 0);
  assert.equal(final.revision.sequence, 2);
});

test("one command resumes 77 of 666 saved pages and continues through review and synthesis sessions", async t => {
  const state = await fixture(t, bundle(2));
  const input = createListenerProfileInput({ subjectId, evidenceRevision: "synthetic-large-profile",
    listening: { sections: { history_tracks: Array.from({ length: 666 * 24 }, (_, index) => ({
      label: `Synthetic track ${index}`, play_count: 1,
    })) } } });
  assert.equal(input.partitions.length, 666);
  const store = state.store.listenerProfileStorage({ subjectId });
  const { provider, model, worker_version } = modelStatus;
  const interrupted = store.begin(input, { provider, model, worker_version });
  for (const part of input.partitions.slice(0, 77)) {
    store.checkpoint(interrupted, validateProfileReview(input, part.partition_id, {
      note: "Previously reviewed before the command stopped.", claims: [finding(part.items[0])],
    }));
  }
  store.interrupt(interrupted);
  await state.application.close();
  await state.open();
  t.mock.method(state.application, "getProfileBuildContext", () => ({
    input, store: state.store.listenerProfileStorage({ subjectId }),
  }));
  let reviewSessions = 0;
  let synthesisSessions = 0;
  const newPages = new Set();
  const progress = [];
  const offsets = [];
  const result = await state.application.buildListenerProfile({
    onProgress: value => progress.push(value.reviewed_partitions),
    runtimeFactory: scriptedRuntime(async session => {
      if (session.phase === "verification") { approve(session); return; }
      assert.ok(reviewSessions + synthesisSessions < 90, "continuation must make finite progress");
      if (session.progress().pending.length) {
        reviewSessions++;
        for (let count = 0; count < 20; count++) {
          const part = session.progress().pending[0];
          if (!part) break;
          assert.ok(!newPages.has(part.partition_id));
          newPages.add(part.partition_id);
          reviewPage(session, part.partition_id);
        }
        return;
      }
      synthesisSessions++;
      const page = session.findings();
      offsets.push(page.offset);
      if (page.next_offset === null) submit(session);
    }),
  });
  assert.equal(result.state, "ready");
  assert.equal(result.reused_partitions, 77);
  assert.equal(result.reviewed_partitions, 666);
  assert.equal(newPages.size, 666 - 77);
  assert.equal(reviewSessions, 30);
  assert.equal(synthesisSessions, Math.ceil(666 / 12));
  assert.deepEqual(offsets, Array.from({ length: synthesisSessions }, (_, index) => index * 12));
  assert.deepEqual([...new Set(progress)], Array.from({ length: 666 - 77 + 1 }, (_, index) => index + 77));
  assert.equal(result.revision.coverage.reviewed_partitions, 666);
});

test("a stalled continuation or changed input stops safely without discarding the previous reading", async t => {
  const state = await fixture(t, bundle(3));
  const first = await state.application.buildListenerProfile({ runtimeFactory: scriptedRuntime() });
  state.store.recordListenerCorrection({ subjectId, entityType: "artist", label: "Dominant artist", stance: "like" });
  let sessions = 0;
  await assert.rejects(state.application.buildListenerProfile({ force: true, runtimeFactory: scriptedRuntime(async session => {
    if (++sessions === 1) reviewPage(session, session.progress().pending[0].partition_id);
  }) }), /stopped making progress/u);
  assert.equal(sessions, 2);
  sessions = 0;
  await assert.rejects(state.application.buildListenerProfile({ runtimeFactory: scriptedRuntime(async session => {
    assert.ok(session.progress().reused_partitions > 0, "the interrupted build's findings are reused");
    sessions++;
  }) }), /stopped making progress/u);
  assert.equal(sessions, 1);
  sessions = 0;
  await assert.rejects(state.application.buildListenerProfile({ force: true, runtimeFactory: scriptedRuntime(async session => {
    sessions++;
    reviewPage(session, session.progress().pending[0].partition_id);
    state.store.recordListenerCorrection({ subjectId, entityType: "artist", label: "Dominant artist", stance: "avoid" });
  }) }), /changed during the build/u);
  assert.equal(sessions, 1);
  assert.equal((await state.application.getListenerProfile()).revision_id, first.revision.revision_id);
});

test("invalid references and changes during synthesis cannot publish a profile", async t => {
  const state = await fixture(t, bundle(3));
  const first = await state.application.buildListenerProfile({ runtimeFactory: scriptedRuntime() });
  await assert.rejects(state.application.buildListenerProfile({ force: true, runtimeFactory: scriptedRuntime(async session => {
    const part = session.read(session.progress().pending[0].partition_id);
    const claim = finding(part.items[0]);
    claim.supporting_refs = ["invented"];
    session.review(part.partition_id, { note: "Bad reference", claims: [claim] });
  }) }), /evidence reference.*invented/u);
  await assert.rejects(state.application.buildListenerProfile({ force: true, runtimeFactory: scriptedRuntime(async session => {
    while (session.progress().pending.length) for (const part of session.progress().pending) reviewPage(session, part.partition_id);
    if (session.phase === "synthesis") {
      submit(session);
      state.store.recordListenerCorrection({ subjectId, entityType: "artist", label: "Dominant artist", stance: "avoid" });
    }
  }) }), /changed during the build/u);
  assert.equal((await state.application.getListenerProfile()).revision_id, first.revision.revision_id);
});

test("one build command continues across Pi session limits until every page is saved", async t => {
  const state = await fixture(t, bundle(2));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new ProfileBuildRuntime({ models, model: faux.getModel(), provider: "faux", modelId: "faux-1", maxTurns: 4 });
  const partitions = state.application.getProfileBuildContext().input.partitions;
  const responses = [];
  const claims = [];
  for (const partition of partitions) {
    responses.push(fauxAssistantMessage([fauxToolCall("moondog_read_profile_digest", { partition_id: partition.partition_id })], { stopReason: "toolUse" }));
    responses.push(context => {
      const result = context.messages.filter(message => message.role === "toolResult" && message.toolName === "moondog_read_profile_digest").at(-1);
      const page = JSON.parse(result.content[0].text);
      return fauxAssistantMessage([fauxToolCall("moondog_record_profile_findings", { partition_id: page.partition_id,
        note: "Inspected the measured evidence.", claims: [finding(page.items[0])] })], { stopReason: "toolUse" });
    });
  }
  responses.push(context => {
    const content = context.messages.find(message => message.role === "user").content;
    const initial = JSON.parse(typeof content === "string" ? content : content.map(item => item.text ?? "").join(""));
    assert.equal(initial.phase, "synthesis");
    assert.equal(initial.saved_findings, undefined);
    claims.push(...initial.global_overview.flatMap(section => section.items.map(finding)));
    for (const result of context.messages.filter(message => message.role === "toolResult" && message.toolName === "moondog_record_profile_findings")) {
      claims.push(...JSON.parse(result.content[0].text).saved_claims);
    }
    return fauxAssistantMessage([fauxToolCall("moondog_submit_listener_profile", { summary: "The retained history records attention, without proving liking.",
      insights: claims.slice(0, 6).map(claim => ({
        kind: claim.kind, statement: claim.statement, scope: claim.scope, uncertainty: claim.uncertainty,
        supporting_refs: claim.supporting_refs, contradicting_refs: claim.contradicting_refs,
      })) })], { stopReason: "toolUse" });
  });
  const verifyBatch = context => {
    const content = context.messages.find(message => message.role === "user").content;
    const initial = JSON.parse(typeof content === "string" ? content : content.map(item => item.text ?? "").join(""));
    assert.equal(initial.phase, "verification");
    assert.ok(initial.candidate.cited_evidence.length > 0);
    const leading = JSON.stringify(context.messages[0]);
    assert.match(leading, /moondog_record_profile_verification/u);
    assert.doesNotMatch(leading, /moondog_record_profile_findings|moondog_submit_listener_profile|moondog_read_profile_findings|moondog_read_profile_digest/u);
    if (!initial.verification_targets.includes("coverage")) {
      assert.ok(initial.candidate.insights.length <= 3);
      assert.equal(initial.candidate.summary, undefined);
      assert.equal(initial.global_overview, undefined);
    }
    let report;
    approve({ candidate: initial.candidate, verify: value => { report = value; } });
    report.checks = report.checks.filter(check => initial.verification_targets.includes(check.target));
    return fauxAssistantMessage([fauxToolCall("moondog_record_profile_verification", report)], { stopReason: "toolUse" });
  };
  responses.push(verifyBatch, verifyBatch, verifyBatch);
  faux.setResponses(responses);
  let output = "";
  const progress = [];
  const result = await runListenerProfileCommand({ application: state.application, args: ["build"],
    runtimeFactory: async () => runtime, onProgress: value => progress.push(value.reviewed_partitions),
    output: { write: text => { output += text; } } });
  assert.equal(result.state, "ready");
  assert.ok(partitions.length * 2 > runtime.maxTurns);
  assert.equal(result.revision.coverage.reviewed_partitions, partitions.length);
  assert.deepEqual([...new Set(progress)], Array.from({ length: partitions.length + 1 }, (_, index) => index));
  assert.match(output, /Saved your new listening profile/u);
  assert.doesNotMatch(output, /Use .* build to continue/u);
  assert.equal(runtime.activeAgent, null);
});

test("profile failures keep the provider diagnosis and report the recoverable checkpoint", async t => {
  const state = await fixture(t, bundle(2));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new ProfileBuildRuntime({ models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  const partitions = state.application.getProfileBuildContext().input.partitions;
  const first = partitions[0];
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("moondog_read_profile_digest", { partition_id: first.partition_id })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("moondog_record_profile_findings", { partition_id: first.partition_id,
      note: "Saved before a provider outage.", claims: [finding(first.items[0])] })], { stopReason: "toolUse" }),
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service unavailable" }),
  ]);
  await assert.rejects(state.application.buildListenerProfile({ runtimeFactory: async () => runtime }), error => {
    assert.match(error.message, /503 Service unavailable/u);
    assert.match(error.message, new RegExp(`Saved progress: 1/${partitions.length} evidence pages`));
    return true;
  });
  assert.equal(runtime.activeAgent, null);
  const resumed = await state.application.buildListenerProfile({ runtimeFactory: scriptedRuntime() });
  assert.equal(resumed.reused_partitions, 1);
  assert.equal(resumed.state, "ready");
});

test("a fresh Pi listening session receives the saved reading, evidence tools and updated constraints", async t => {
  const state = await fixture(t, bundle(3));
  await state.application.buildListenerProfile({ runtimeFactory: scriptedRuntime() });
  await state.application.close();
  await state.open();
  const catalog = t.mock.method(state.store, "profileCatalog");
  const digest = t.mock.method(state.store, "profileEvidenceRevision");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({ application: state.application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  faux.setResponses([context => {
    const prompt = JSON.stringify(context.messages);
    assert.match(prompt, /Saved listener reading/u);
    assert.match(prompt, /smaller retained interest/u);
    return fauxAssistantMessage([fauxToolCall("moondog_profile_saved", { limit: 1 })], { stopReason: "toolUse" });
  }, context => {
    const result = context.messages.find(message => message.role === "toolResult" && message.toolName === "moondog_profile_saved");
    const page = JSON.parse(result.content[0].text);
    assert.equal(page.state, "current");
    return fauxAssistantMessage([fauxToolCall("moondog_profile_saved", { claim_id: page.claims[0].claim_id })], { stopReason: "toolUse" });
  }, context => {
    assert.match(JSON.stringify(context.messages), /supporting_evidence/u);
    return fauxAssistantMessage([fauxText("Recovered the saved reading and its evidence.")]);
  }]);
  assert.match((await runtime.prompt("Use my saved profile to explain a recommendation.")).text, /Recovered/u);
  assert.equal(catalog.mock.callCount(), 1, "model turns and evidence reads reuse the unchanged input");
  assert.equal(digest.mock.callCount(), 1);
  state.store.recordListenerCorrection({ subjectId, entityType: "artist", label: "Dominant artist", stance: "avoid" });
  const fresh = new PiAgentRuntime({ application: state.application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  faux.setResponses([context => {
    const prompt = JSON.stringify(context.messages);
    assert.match(prompt, /Source evidence, listener choices or analysis changed/u);
    assert.doesNotMatch(prompt, /smaller retained interest/u);
    return fauxAssistantMessage([fauxText("The saved reading needs an update.")]);
  }]);
  await fresh.prompt("What fits my current taste?");
  assert.equal(catalog.mock.callCount(), 2, "a local correction invalidates the saved input");
  assert.equal(digest.mock.callCount(), 2);
});

test("ordinary Pi turns skip build analysis when no saved reading exists", async t => {
  const state = await fixture(t, bundle(3));
  const catalog = t.mock.method(state.store, "profileCatalog");
  const digest = t.mock.method(state.store, "profileEvidenceRevision");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({ application: state.application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("moondog_profile_saved", {})], { stopReason: "toolUse" }),
    context => {
      const result = context.messages.find(message => message.role === "toolResult" && message.toolName === "moondog_profile_saved");
      assert.equal(JSON.parse(result.content[0].text).state, "missing");
      return fauxAssistantMessage([fauxText("No saved reading yet.")]);
    },
    fauxAssistantMessage([fauxText("Ready to listen.")]),
  ]);
  await runtime.prompt("Do I have a saved listening profile?");
  await runtime.prompt("Let's listen.");
  assert.equal(catalog.mock.callCount(), 0);
  assert.equal(digest.mock.callCount(), 0);
});

test("saved input detects other connections and new imports without rescanning unchanged evidence", async t => {
  const state = await fixture(t, bundle(3));
  await state.application.buildListenerProfile({ runtimeFactory: scriptedRuntime() });
  await state.application.close();
  await state.open();
  const other = await openListeningHistoryStore({ databasePath: path.join(state.root, "listening-history.sqlite") });
  try {
    const catalog = t.mock.method(state.store, "profileCatalog");
    const digest = t.mock.method(state.store, "profileEvidenceRevision");
    assert.equal((await state.application.getListenerProfile()).state, "current");
    assert.equal((await state.application.getListenerProfile()).state, "current");
    assert.equal(catalog.mock.callCount(), 1);
    assert.equal(digest.mock.callCount(), 1);

    other.recordListenerCorrection({ subjectId, entityType: "artist", label: "Dominant artist", stance: "avoid" });
    assert.equal((await state.application.getListenerProfile()).state, "stale");
    assert.equal((await state.application.getListenerProfile()).state, "stale");
    assert.equal(catalog.mock.callCount(), 2);
    assert.equal(digest.mock.callCount(), 2);
    assert.ok(state.application.getProfileBuildContext().input.partitions.some(part => part.section === "listener_avoids"));

    state.store.ingestImport(bundle(4, "b"));
    assert.equal((await state.application.getListenerProfile()).state, "stale");
    assert.equal(state.application.getProfileBuildContext().input.manifest.coverage.effective_listening_events, 4);
    assert.equal(catalog.mock.callCount(), 3);
    assert.equal(digest.mock.callCount(), 3);
  } finally { other.close(); }
});

test("saved profile CLI reads and unchanged builds bypass unrelated startup services", async t => {
  const state = await fixture(t, bundle(3));
  state.store.localSubjectId({ preferredSubjectId: subjectId, create: true });
  const built = await state.application.buildListenerProfile({ runtimeFactory: scriptedRuntime() });
  await state.application.close();
  const marker = path.join(state.root, "codex-probed");
  const codex = path.join(state.root, "codex");
  await writeFile(codex, '#!/bin/sh\n: > "$MOONDOG_PROBE_MARKER"\nexit 1\n', { mode: 0o700 });
  for (const file of ["memory.sqlite", "settings.json", "spotify.json", "auth.json"]) {
    await writeFile(path.join(state.root, file), "invalid unrelated service state");
  }
  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MOONDOG_"))),
    MOONDOG_STATE_HOME: state.root, MOONDOG_CONFIG_HOME: state.root,
    MOONDOG_CODEX_BIN: codex, MOONDOG_PROBE_MARKER: marker, MOONDOG_UPDATE_CHECK: "off",
  };
  const run = args => promisify(execFile)(process.execPath,
    ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../../scripts/moondog.mjs", import.meta.url)), "profile", ...args, "--json"],
    { env: environment, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  const saved = JSON.parse((await run(["saved"])).stdout);
  assert.equal(saved.revision_id, built.revision.revision_id);
  assert.equal(saved.state, "current");
  const explained = JSON.parse((await run(["explain", "1"])).stdout);
  assert.equal(explained.claim.claim_id, saved.claims[0].claim_id);
  assert.ok(explained.supporting_evidence.length);
  assert.equal(JSON.parse((await run(["build"])).stdout).state, "unchanged");
  await assert.rejects(run(["build", "--force"]), error => {
    assert.match(error.stderr, /runtime settings are not valid JSON/u);
    return true;
  });
  await assert.rejects(access(marker), { code: "ENOENT" });
});
