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
import { projectSpotifyExtendedStreamingHistory } from "../../src/integrations/spotify/extended-streaming-history.mjs";
import { ProfileBuildRuntime } from "../../src/runtime/pi/profile-build-runtime.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";
import { runListenerProfileCommand } from "../../src/surfaces/cli/listener-profile-command.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";
const modelStatus = { state: "configured", provider: "faux", model: "faux-1", worker_version: "profile-investigation/2" };

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

function insight(ref, statement, kind = "observation") {
  return { kind, statement, scope: "Imported listening history.", uncertainty: "Attention is not a confirmed preference.",
    supporting_refs: [ref], contradicting_refs: [] };
}

// The leading artist comes from the dossier; the quiet tail track only from a catalog search.
function write(session, summary = "Most of your listening goes to one artist, and a smaller interest stays with you.") {
  assert.doesNotMatch(JSON.stringify(session.dossier), /spotify:track:|subject_id|track_ref_id|correction_id|evidence_id/u);
  const leader = session.dossier.lifetime_artists[0];
  const tail = session.search({ query: "Quiet interest" }).items[0];
  return session.submit({ summary, insights: [
    insight(leader.ref, `${leader.name} leads your listening.`),
    ...(tail ? [insight(tail.reference_id, "Quiet interest by Smaller artist is a smaller retained interest.", "hypothesis")] : []),
  ] });
}

function verdict(session, issues = []) {
  return session.record({ candidate_id: session.candidate.candidate_id, verdict: issues.length ? "revise" : "pass", issues });
}

function scriptedRuntime(investigate = async session => (session.phase === "check" ? verdict(session) : write(session))) {
  return async () => ({ publicStatus: () => modelStatus, investigate, abort() {} });
}

test("a build writes, checks and saves a reading with a smaller interest, survives restart, and updates after a choice", async t => {
  const state = await fixture(t);
  const phases = [];
  const runtimeFactory = scriptedRuntime(async session => {
    phases.push(session.phase);
    return session.phase === "check" ? verdict(session) : write(session);
  });
  const built = await state.application.buildListenerProfile({ runtimeFactory });
  assert.equal(built.state, "ready");
  assert.deepEqual(phases, ["synthesis", "check"]);
  assert.equal(built.revision.verification.state, "passed");
  const tail = built.revision.highlights.find(claim => claim.statement.includes("Quiet interest"));
  assert.equal(tail.kind, "hypothesis");
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
  assert.match(output, /Built \d{4}-\d{2}-\d{2} from 141 plays, 2026-08-01 to 2026-08-01 · checked/u);
  // Markdown renumbers ordered lists from the first item, so findings print in ascending order.
  assert.deepEqual([...output.matchAll(/^(\d+)\. /gmu)].map(match => Number(match[1])), [1, 2, 3]);
  assert.match(output, /your choice · artist/u);
  assert.match(output, /interpretation · Imported listening history/u);
  output = "";
  await runListenerProfileCommand({ application: state.application, args: ["explain", "1"], output: { write: text => { output += text; } } });
  assert.match(output, /Supporting evidence:/u);
  assert.doesNotMatch(output, /subject_id|spotify:track:|track_ref_id/u);
});

test("the check can ask for one revision, and an unresolved concern is saved and shown with the reading", async t => {
  for (const finalVerdict of ["pass", "revise"]) {
    const state = await fixture(t, bundle(3));
    const phases = [];
    const issue = target => [{ target, problem: "The summary calls the leader a favorite.", correction: "Describe attention, not love." }];
    const built = await state.application.buildListenerProfile({ runtimeFactory: scriptedRuntime(async session => {
      phases.push(session.phase);
      if (session.phase === "synthesis") return write(session, "Your favorite is the leading artist.");
      if (session.phase === "revision") {
        assert.equal(session.check.issues[0].target, "summary");
        return write(session, "Most of your attention goes to the leading artist.");
      }
      return verdict(session, phases.length === 2 || finalVerdict === "revise" ? issue("summary") : []);
    }) });
    assert.deepEqual(phases, ["synthesis", "check", "revision", "check"]);
    assert.equal(built.revision.summary, "Most of your attention goes to the leading artist.");
    assert.equal(built.revision.verification.revisions, 1);
    assert.equal(built.revision.verification.checks.length, 2);
    assert.equal(built.revision.verification.state, finalVerdict === "pass" ? "revised" : "flagged");
    assert.equal((await state.application.getListenerProfile()).state, "current");
    let output = "";
    await runListenerProfileCommand({ application: state.application, args: ["saved"], output: { write: text => { output += text; } } });
    if (finalVerdict === "pass") {
      assert.match(output, /checked and revised once/u);
      assert.doesNotMatch(output, /still flagged/u);
    } else {
      assert.match(output, /checked; one concern remains/u);
      assert.match(output, /The final check still flagged:\n- The summary calls the leader a favorite\./u);
    }
  }
});

test("an interrupted build resumes from its saved draft and keeps the previous reading", async t => {
  const state = await fixture(t, bundle(3));
  const first = await state.application.buildListenerProfile({ runtimeFactory: scriptedRuntime() });
  state.store.recordListenerCorrection({ subjectId, entityType: "artist", label: "Dominant artist", stance: "like" });
  const controller = new AbortController();
  await assert.rejects(state.application.buildListenerProfile({ signal: controller.signal, runtimeFactory: scriptedRuntime(async session => {
    if (session.phase === "synthesis") return write(session);
    controller.abort();
  }) }), { name: "AbortError" });
  assert.equal((await state.application.getListenerProfile()).revision_id, first.revision.revision_id);
  await state.application.close();
  await state.open();
  const phases = [];
  const progress = [];
  const final = await state.application.buildListenerProfile({ onProgress: value => progress.push(value),
    runtimeFactory: scriptedRuntime(async session => {
      phases.push(session.phase);
      return session.phase === "check" ? verdict(session) : write(session);
    }) });
  assert.deepEqual(phases, ["check"], "the saved draft is checked, not rewritten");
  assert.equal(progress[0].resumed, true);
  assert.equal(final.revision.sequence, 2);
  assert.equal(final.revision.parent_revision_id, first.revision.revision_id);
});

test("a stalled session, a changed input or an invalid finding cannot publish a profile", async t => {
  const state = await fixture(t, bundle(3));
  const first = await state.application.buildListenerProfile({ runtimeFactory: scriptedRuntime() });
  await assert.rejects(state.application.buildListenerProfile({ force: true, runtimeFactory: scriptedRuntime(async () => {}) }),
    /stopped making progress/u);
  await assert.rejects(state.application.buildListenerProfile({ force: true, runtimeFactory: scriptedRuntime(async session => {
    write(session);
    state.store.recordListenerCorrection({ subjectId, entityType: "artist", label: "Dominant artist", stance: "avoid" });
  }) }), /changed during the build/u);
  const ref = (await state.application.getProfileBuildContext()).input.evidence.keys().next().value;
  for (const [bad, message] of [
    [{ ...insight(ref, "Invented."), supporting_refs: ["invented"] }, /unknown IDs/u],
    [{ ...insight(ref, "This artist is your favorite."), kind: "listener_assertion" }, /Only the listener/u],
  ]) {
    await assert.rejects(state.application.buildListenerProfile({ force: true, runtimeFactory: scriptedRuntime(async session =>
      session.submit({ summary: "A fictional reading.", insights: [bad] })) }), message);
  }
  assert.equal((await state.application.getListenerProfile()).revision_id, first.revision.revision_id);
});

test("the Pi runtime writes with the dossier and checks in a fresh session through its own tools", async t => {
  const state = await fixture(t, bundle(2));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new ProfileBuildRuntime({ models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  const initial = context => {
    const content = context.messages.find(message => message.role === "user").content;
    return JSON.parse(typeof content === "string" ? content : content.map(item => item.text ?? "").join(""));
  };
  faux.setResponses([context => {
    const value = initial(context);
    assert.equal(value.phase, "synthesis");
    assert.equal(value.candidate, undefined);
    const tools = JSON.stringify(context.tools ?? context.messages[0]);
    assert.match(tools, /moondog_submit_listener_profile/u);
    assert.doesNotMatch(tools, /moondog_record_profile_check|moondog_read_profile_digest|moondog_record_profile_findings/u);
    const leader = value.dossier.lifetime_artists[0];
    return fauxAssistantMessage([fauxToolCall("moondog_submit_listener_profile", { summary: "Your listening centers on one artist.",
      insights: [insight(leader.ref, `${leader.name} leads your listening.`)] })], { stopReason: "toolUse" });
  }, context => {
    const value = initial(context);
    assert.equal(value.phase, "check");
    assert.equal(value.candidate.insights.length, 1);
    assert.ok(value.candidate.cited_evidence.length > 0);
    const tools = JSON.stringify(context.tools ?? context.messages[0]);
    assert.match(tools, /moondog_record_profile_check/u);
    assert.doesNotMatch(tools, /moondog_submit_listener_profile/u);
    return fauxAssistantMessage([fauxToolCall("moondog_record_profile_check", {
      candidate_id: value.candidate.candidate_id, verdict: "pass", issues: [] })], { stopReason: "toolUse" });
  }]);
  let output = "";
  const result = await runListenerProfileCommand({ application: state.application, args: ["build"],
    runtimeFactory: async () => runtime, output: { write: text => { output += text; } } });
  assert.equal(result.state, "ready");
  assert.equal(result.revision.verification.state, "passed");
  assert.match(output, /Saved your new listening profile/u);
  assert.equal(runtime.activeAgent, null);
});

test("the reading is written in the listener's language, and checking stays language-neutral", async t => {
  const userInput = context => {
    const content = context.messages.find(message => message.role === "user").content;
    return JSON.parse(typeof content === "string" ? content : content.map(item => item.text ?? "").join(""));
  };
  const state = await fixture(t, bundle(2));
  state.application.locale = "es";
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new ProfileBuildRuntime({ models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  const prompts = [];
  faux.setResponses([context => {
    prompts.push(JSON.stringify(context.messages[0]));
    const value = userInput(context);
    const leader = value.dossier.lifetime_artists[0];
    return fauxAssistantMessage([fauxToolCall("moondog_submit_listener_profile", { summary: "Tu escucha gira en torno a un artista.",
      insights: [insight(leader.ref, `${leader.name} encabeza tu escucha.`)] })], { stopReason: "toolUse" });
  }, context => {
    prompts.push(JSON.stringify(context.messages[0]));
    const value = userInput(context);
    return fauxAssistantMessage([fauxToolCall("moondog_record_profile_check", {
      candidate_id: value.candidate.candidate_id, verdict: "pass", issues: [] })], { stopReason: "toolUse" });
  }]);
  const result = await runListenerProfileCommand({ application: state.application, args: ["build"],
    runtimeFactory: async () => runtime, output: { write() {} } });
  assert.equal(result.state, "ready");
  assert.match(prompts[0], /Write the summary and insights in Spanish\./u);
  assert.doesNotMatch(prompts[1], /in Spanish/u);
});

test("profile failures keep the provider diagnosis and the saved draft", async t => {
  const state = await fixture(t, bundle(2));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new ProfileBuildRuntime({ models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  const leader = state.application.getProfileBuildContext().input.evidence.keys().next().value;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("moondog_submit_listener_profile", { summary: "Saved before a provider outage.",
      insights: [insight(leader, "This evidence leads your listening.")] })], { stopReason: "toolUse" }),
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service unavailable" }),
  ]);
  await assert.rejects(state.application.buildListenerProfile({ runtimeFactory: async () => runtime }), error => {
    assert.match(error.message, /503 Service unavailable/u);
    assert.match(error.message, /saved draft are kept/u);
    return true;
  });
  assert.equal(runtime.activeAgent, null);
  const phases = [];
  const resumed = await state.application.buildListenerProfile({ runtimeFactory: scriptedRuntime(async session => {
    phases.push(session.phase);
    return session.phase === "check" ? verdict(session) : write(session);
  }) });
  assert.deepEqual(phases, ["check"]);
  assert.equal(resumed.revision.summary, "Saved before a provider outage.");
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
    assert.match(prompt, /a smaller interest stays with you/u);
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
    assert.doesNotMatch(prompt, /a smaller interest stays with you/u);
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
    assert.ok([...state.application.getProfileBuildContext().input.evidence.values()].some(entry => entry.section === "listener_avoids"));

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

test("the agent reads the profile summary of a listener who imported only Spotify", async t => {
  const state = await fixture(t, bundle(3));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({ application: state.application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("moondog_profile_summary", {})], { stopReason: "toolUse" }),
    context => {
      const result = context.messages.find(message => message.role === "toolResult" && message.toolName === "moondog_profile_summary");
      assert.equal(result.isError, false, result.content[0].text);
      const summary = JSON.parse(result.content[0].text);
      assert.equal(summary.coverage.aggregate_play_count, undefined);
      assert.equal(summary.source, undefined);
      assert.equal(summary.listening_source.kind, "private_effective_listening_evidence");
      return fauxAssistantMessage([fauxText("Mostly one artist so far.")]);
    },
  ]);
  assert.equal((await runtime.prompt("What does my listening say?")).text, "Mostly one artist so far.");
});
