import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createSyntheticDomainServices } from "../../src/core/synthetic-domain-services.mjs";
import { openLocalMemoryStore } from "../../src/memory/local-memory-store.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

// The pattern of the launcher's openConversation, on synthetic data and faux models: each
// conversation is an application that shares the main one's memory store, with its own fork of
// the domain services and its own agent, bound to its session before the agent is built.
async function conversations(root) {
  const memoryStore = await openLocalMemoryStore({ databasePath: path.join(root, "memory.sqlite") });
  const shared = { importsRoot: "/private/moondog-synthetic-missing-source", memoryStore };
  const application = new MoondogApplication({ ...shared,
    domainServices: createSyntheticDomainServices({ subjectScope: { subjectId: "trusted-synthetic-subject" } }) });
  const open = ({ sessionId = null, reason = "user_new" } = {}) => {
    const conversation = new MoondogApplication({ ...shared, domainServices: application.domainServices.fork(), ownsServices: false });
    if (sessionId) conversation.resumeSession(sessionId);
    else conversation.startNewSession(reason);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiAgentRuntime({ application: conversation, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
    return { application: conversation, runtime, faux, session: conversation.memorySession.session_id };
  };
  return { application, memoryStore, open };
}

const searchResult = (context) => JSON.parse(context.messages
  .findLast((message) => message.role === "toolResult" && message.toolName === "moondog_library_search").content[0].text);

const planCall = (search) => fauxToolCall("moondog_playlist_plan", {
  intent: "Find 2 tracks for a late-night drive.",
  requested_track_count: 2,
  candidate_set_ids: [search.candidate_set_id],
  track_refs: search.tracks.map((track) => ({ track_ref_id: track.track_ref_id, selection_reason: "A night track from the library." })),
  ordering_notes: "Familiar first.",
});

// A planning turn that searches the library, then waits on its model until released, then
// plans from the candidate set its own search returned.
function pausedPlan(faux, reply) {
  const paused = Promise.withResolvers();
  const release = Promise.withResolvers();
  const turn = { paused: paused.promise, release: release.resolve, search: null };
  faux.appendResponses([
    fauxAssistantMessage([fauxToolCall("moondog_library_search", { query: "night", limit: 2 })], { stopReason: "toolUse" }),
    async (context) => {
      turn.search = searchResult(context);
      paused.resolve();
      await release.promise;
      return fauxAssistantMessage([planCall(turn.search)], { stopReason: "toolUse" });
    },
    fauxAssistantMessage([fauxText(reply)]),
  ]);
  return turn;
}

test("two conversations each begin and finish a prompt while the other is mid-prompt, in their own sessions", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-concurrent-conversations-"));
  const { application, memoryStore, open } = await conversations(root);
  const first = open();
  const second = open({ reason: "app_start" });
  context.after(async () => {
    second.application.close();
    application.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.notEqual(first.session, second.session);

  const firstTurn = pausedPlan(first.faux, "FIRST_REPLY");
  const firstPrompt = first.runtime.prompt("Plan 2 night tracks in the first conversation.");
  await firstTurn.paused;

  // The second conversation begins while the first is mid-prompt.
  const secondTurn = pausedPlan(second.faux, "SECOND_REPLY");
  const secondPrompt = second.runtime.prompt("Plan 2 night tracks in the second conversation.");
  await secondTurn.paused;

  // The first finishes from its own candidate set, which the second's prompt start left in place.
  firstTurn.release();
  const firstResult = await firstPrompt;
  assert.equal(firstResult.status, "completed");
  assert.equal(firstResult.playlist_plan?.track_count, 2, "the first conversation's plan lost its candidate set");
  assert.deepEqual(firstResult.playlist_plan.tracks.map((track) => track.track_ref_id),
    firstTurn.search.tracks.map((track) => track.track_ref_id));

  // The first begins again while the second is still mid-prompt; then the second finishes,
  // although the first's prompt end and start came in between.
  const againTurn = pausedPlan(first.faux, "FIRST_AGAIN");
  const againPrompt = first.runtime.prompt("Plan 2 more night tracks in the first conversation.");
  await againTurn.paused;
  secondTurn.release();
  const secondResult = await secondPrompt;
  assert.equal(secondResult.status, "completed");
  assert.equal(secondResult.playlist_plan?.track_count, 2, "the second conversation's plan lost its candidate set");
  againTurn.release();
  assert.equal((await againPrompt).status, "completed");

  // Each conversation's turns landed in its own session.
  const entries = (session) => memoryStore.readConversationEntries(session).map((entry) => [entry.user_text, entry.outcome]);
  assert.deepEqual(entries(first.session), [
    ["Plan 2 night tracks in the first conversation.", "completed"],
    ["Plan 2 more night tracks in the first conversation.", "completed"],
  ]);
  assert.deepEqual(entries(second.session), [["Plan 2 night tracks in the second conversation.", "completed"]]);
  assert.deepEqual(memoryStore.readSessionTurns(second.session, { limit: 10 }).map((turn) => turn.role), ["user", "assistant"]);
  const listed = application.listSavedSessions().map((session) => session.session_id);
  assert.ok(listed.includes(first.session) && listed.includes(second.session));

  // Closing one conversation leaves the shared store working for the other.
  first.application.close();
  second.faux.appendResponses([fauxAssistantMessage([fauxText("STILL_HERE")])]);
  assert.equal((await second.runtime.prompt("Are you still there?")).text, "STILL_HERE");
  assert.equal(entries(second.session).length, 2);

  // A conversation opened on a saved session picks up its turns.
  second.application.close();
  const reopened = open({ sessionId: first.session });
  assert.deepEqual(reopened.application.currentConversationTurns().filter((turn) => turn.role === "user").map((turn) => turn.text),
    ["Plan 2 night tracks in the first conversation.", "Plan 2 more night tracks in the first conversation."]);
  reopened.application.close();
});
