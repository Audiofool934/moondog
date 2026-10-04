import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createListeningProfileDomainServices } from "../../src/core/listening-profile-domain-services.mjs";
import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";
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
  const options = { databasePath: path.join(root, "history.sqlite"), boundaryRoot: root };
  const state = {};
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
  const selected = [...claims.filter(claim => claim.kind === "listener_assertion"),
    ...claims.filter(claim => claim.statement.includes("Quiet interest")), ...claims].slice(0, 12);
  session.submit({ summary: "There is broad dominant attention and a smaller retained interest; explicit choices take precedence.",
    highlight_claim_ids: [...new Set(selected.map(claim => claim.claim_id))] });
}

function scriptedRuntime(investigate = async session => {
  while (session.progress().pending.length) for (const item of session.progress().pending) reviewPage(session, item.partition_id);
  submit(session);
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
  assert.ok(next.revision.highlights.some(claim => claim.kind === "listener_assertion" && claim.stance === "avoid" && /Smaller artist/u.test(claim.statement)));
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
  await assert.rejects(state.application.buildListenerProfile({ signal: controller.signal, runtimeFactory: scriptedRuntime(async session => {
    reviewPage(session, session.progress().pending[0].partition_id);
    controller.abort();
  }) }), { name: "AbortError" });
  assert.equal((await state.application.getListenerProfile()).revision_id, first.revision.revision_id);
  await state.application.close();
  await state.open();
  let resumed;
  const final = await state.application.buildListenerProfile({ runtimeFactory: scriptedRuntime(async session => {
    resumed = session.progress();
    while (session.progress().pending.length) for (const part of session.progress().pending) reviewPage(session, part.partition_id);
    submit(session);
  }) });
  assert.ok(resumed.reused_partitions > 0);
  assert.equal(final.revision.sequence, 2);
});

test("invalid references and changes during synthesis cannot publish a profile", async t => {
  const state = await fixture(t, bundle(3));
  const first = await state.application.buildListenerProfile({ runtimeFactory: scriptedRuntime() });
  await assert.rejects(state.application.buildListenerProfile({ force: true, runtimeFactory: scriptedRuntime(async session => {
    const part = session.read(session.progress().pending[0].partition_id);
    const claim = finding(part.items[0]);
    claim.supporting_refs = ["invented"];
    session.review(part.partition_id, { note: "Bad reference", claims: [claim] });
  }) }), /evidence reference/u);
  await assert.rejects(state.application.buildListenerProfile({ force: true, runtimeFactory: scriptedRuntime(async session => {
    while (session.progress().pending.length) for (const part of session.progress().pending) reviewPage(session, part.partition_id);
    submit(session);
    state.store.recordListenerCorrection({ subjectId, entityType: "artist", label: "Dominant artist", stance: "avoid" });
  }) }), /changed during the build/u);
  assert.equal((await state.application.getListenerProfile()).revision_id, first.revision.revision_id);
});

test("actual Pi worker reads, checkpoints and submits through model tools", async t => {
  const state = await fixture(t, bundle(2));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new ProfileBuildRuntime({ models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
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
    for (const result of context.messages.filter(message => message.role === "toolResult" && message.toolName === "moondog_record_profile_findings")) {
      claims.push(...JSON.parse(result.content[0].text).saved_claims);
    }
    return fauxAssistantMessage([fauxToolCall("moondog_submit_listener_profile", { summary: "The retained history records attention, without proving liking.",
      highlight_claim_ids: claims.slice(0, 6).map(claim => claim.claim_id) })], { stopReason: "toolUse" });
  });
  faux.setResponses(responses);
  const result = await state.application.buildListenerProfile({ runtimeFactory: async () => runtime });
  assert.equal(result.state, "ready");
  assert.equal(result.revision.coverage.reviewed_partitions, partitions.length);
  assert.equal(runtime.activeAgent, null);
});

test("a fresh Pi listening session receives the saved reading, evidence tools and updated constraints", async t => {
  const state = await fixture(t, bundle(3));
  await state.application.buildListenerProfile({ runtimeFactory: scriptedRuntime() });
  await state.application.close();
  await state.open();
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
  state.store.recordListenerCorrection({ subjectId, entityType: "artist", label: "Dominant artist", stance: "avoid" });
  const fresh = new PiAgentRuntime({ application: state.application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  faux.setResponses([context => {
    const prompt = JSON.stringify(context.messages);
    assert.match(prompt, /New source evidence or listener choices/u);
    assert.doesNotMatch(prompt, /smaller retained interest/u);
    return fauxAssistantMessage([fauxText("The saved reading needs an update.")]);
  }]);
  await fresh.prompt("What fits my current taste?");
});
