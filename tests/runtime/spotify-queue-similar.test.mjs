import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createListeningProfileDomainServices } from "../../src/core/listening-profile-domain-services.mjs";
import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";
const tracks = ["A", "B", "C"].map((letter, index) => ({
  track_ref_id: `22222222-2222-4222-8222-22222222222${index}`, title: `Fictional Song ${letter}`,
  artist_credit: `Fictional Artist ${letter}`, release: `Fictional Release ${letter}`,
  candidate_scope: "external_catalog", catalog_provider: "listenbrainz",
  discovery_basis: { kind: "listenbrainz_collaborative_artist_similarity", seed_artist: "Seed Band & Friends", adjacent_artist: `Fictional Artist ${letter}`, mode: "medium" },
}));
const source = { provider: "listenbrainz", catalog: "lb_radio_artist+metadata_recording", identity_provider: "wikidata",
  retrieved_at: "2026-09-01T00:00:00Z", license: "Fictional CC0 metadata", recommendation_basis: "listenbrainz_collaborative_artist_similarity",
  mode: "medium", popularity_range: { begin: 0, end: 50 }, seed_artist: "Seed Band & Friends", coverage: "Fictional artist adjacency." };

async function fixture(context, hook = () => {}) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-similar-queue-"));
  const store = await openListeningHistoryStore({ databasePath: path.join(root, "history.sqlite") });
  const calls = [];
  const step = async (stage, options) => { calls.push(stage); await hook(stage, options); };
  const service = {
    async currentPlayer(options) { await step("playback", options); return { state: "available",
      item: { type: "track", uri: "spotify:track:seed", artists: ["Seed Band & Friends", "Second Artist"] } }; },
    async queue(options) { await step("queue_read", options); return { queue: [], truncated: false }; },
    async addToQueue(input, options) { await step("write", options); return { ok: true }; },
  };
  const resolver = { async resolve(selected, options) {
    await step("resolution", options);
    return { resolutions: selected.map((track) => ({ track_ref_id: track.track_ref_id, status: "resolved",
      spotify: { uri: `spotify:track:${track.artist_credit.at(-1)}` } })) };
  } };
  const application = new MoondogApplication({ importsRoot: path.join(root, "missing-imports"),
    domainServices: createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId }),
    musicSimilarity: { async discoverSimilarTracks(input, options) {
      assert.equal(input.artistName, "Seed Band & Friends");
      await step("similarity", options); return { state: "resolved", tracks, source };
    } },
    spotifyConnection: { service, resolver, ready: () => true, missingScopes: () => [], publicStatus: () => ({ provider: "spotify", state: "ready" }) } });
  context.after(async () => { application.close(); await rm(root, { recursive: true, force: true }); });
  return { application, service, resolver, calls, store };
}

test("similar queue excludes current, observed and recently accepted identities across requests", async (context) => {
  const { application, service, calls } = await fixture(context);
  service.queue = async () => ({ currently_playing: { uri: "spotify:track:A" }, queue: [{ uri: "spotify:track:B" }], truncated: true });
  const first = await application.spotifyQueueSimilar({ count: 3 });
  assert.equal(first.state, "accepted");
  assert.equal(first.queued_count, 1);
  assert.equal(first.queued[0].title, "Fictional Song C");
  assert.equal(first.skipped_duplicate_count, 2);
  assert.equal(first.queue_observation_truncated, true);
  assert.equal((await application.spotifyQueueSimilar({ count: 3 })).state, "no_candidates");
  assert.equal(calls.filter((value) => value === "write").length, 1);
  await assert.rejects(application.spotifyQueueSimilar({ count: 11 }), { code: "invalid_similar_queue_count" });
});

test("similar queue applies Avoid before selection and rechecks corrections before writing; Undo restores eligibility", async (context) => {
  const { application, resolver, store } = await fixture(context);
  const avoid = store.recordListenerCorrection({ subjectId, entityType: "artist", label: "Fictional Artist B", stance: "avoid" });
  const resolve = resolver.resolve;
  resolver.resolve = async (...args) => {
    const result = await resolve(...args);
    store.recordListenerCorrection({ subjectId, entityType: "artist", label: "Fictional Artist C", stance: "avoid" });
    resolver.resolve = resolve;
    return result;
  };
  const first = await application.spotifyQueueSimilar({ count: 3 });
  assert.deepEqual(first.queued.map((track) => track.title), ["Fictional Song A"]);
  assert.equal(first.skipped_avoided_count, 1);
  store.retractListenerCorrection({ subjectId, correctionId: avoid.correction_id });
  const second = await application.spotifyQueueSimilar({ count: 3 });
  assert.deepEqual(second.queued.map((track) => track.title), ["Fictional Song B"]);
});

for (const stage of ["before", "playback", "similarity", "resolution", "queue_read"]) {
  test(`similar queue cancellation at ${stage} starts no writes`, async (context) => {
    const controller = new AbortController();
    const { application, calls } = await fixture(context, (current, { signal }) => {
      assert.equal(signal, controller.signal);
      if (current === stage) controller.abort();
    });
    if (stage === "before") controller.abort();
    await assert.rejects(application.spotifyQueueSimilar({ count: 2 }, { signal: controller.signal }), { name: "AbortError" });
    assert.equal(calls.includes("write"), false);
    if (stage === "before") assert.equal(calls.length, 0);
  });
}

for (const accepted of [0, 1]) {
  test(`an uncertain queue failure after ${accepted} accepted writes stops and reports the exact known effects`, async (context) => {
    let writes = 0;
    const { application } = await fixture(context, (stage) => {
      if (stage === "write" && writes++ === accepted) throw Object.assign(new Error("Fictional connection failure"), { code: "spotify_network_error" });
    });
    application.beginPrompt();
    const receipt = await application.spotifyQueueSimilar({ count: 3 });
    assert.equal(receipt.state, accepted ? "partial" : "unknown");
    assert.equal(receipt.outcome_unknown, true);
    assert.equal(receipt.queued.length, accepted);
    assert.equal(receipt.not_added.length, 2 - accepted);
    assert.equal(writes, accepted + 1);
    await assert.rejects(application.spotifyQueueSimilar(), { code: "spotify_similar_queue_already_attempted" });
    application.endPrompt();
  });
}

test("runtime cancellation after one accepted similar-queue write renders the authoritative partial receipt", async (context) => {
  let runtime;
  const { application, calls } = await fixture(context, (stage) => { if (stage === "write") runtime.abort(); });
  const faux = fauxProvider();
  const models = createModels(); models.setProvider(faux.provider);
  runtime = new PiAgentRuntime({ application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  faux.setResponses([fauxAssistantMessage([fauxToolCall("moondog_spotify_queue_similar", { count: 3 })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Everything was queued.")])]);
  const result = await runtime.prompt("Queue three songs like what is playing");
  assert.equal(result.status, "aborted");
  assert.equal(result.spotify_queue_plan.state, "partial");
  assert.equal(result.spotify_queue_plan.cancelled, true);
  assert.match(result.text, /Fictional Song A/u);
  assert.match(result.text, /cancellation/u);
  assert.equal(calls.filter((value) => value === "write").length, 1);
});

test("no playback is an explicit no-op and queue inspection failure starts no writes", async (context) => {
  const { application, service, calls } = await fixture(context);
  const currentPlayer = service.currentPlayer;
  service.currentPlayer = async () => ({ state: "inactive" });
  assert.equal((await application.spotifyQueueSimilar()).state, "no_playback");
  assert.equal(calls.length, 0);
  service.currentPlayer = currentPlayer;
  service.queue = async () => { throw new Error("Fictional queue unavailable"); };
  await assert.rejects(application.spotifyQueueSimilar(), /Fictional queue unavailable/u);
  assert.equal(calls.includes("write"), false);
});

for (const first of ["control", "similar_unknown", "similar_partial"]) {
  test(`a stopped ${first} action fences all subsequent playback tools in the turn`, async context => {
    let writes = 0;
    const { application, service, calls } = await fixture(context, stage => {
      if (first !== "control" && stage === "write" && writes++ === (first === "similar_partial" ? 1 : 0)) {
        throw Object.assign(new Error("Fictional uncertain result"), { code: "spotify_network_error", outcomeUnknown: true });
      }
    });
    service.resume = async () => {
      calls.push("resume");
      if (first === "control") throw Object.assign(new Error("Fictional rejection"), { code: "spotify_api_error", status: 400 });
      return { provider: "spotify", ok: true, effect: "write_external", action: "playback.resume", state: "accepted" };
    };
    const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
    const runtime = new PiAgentRuntime({ application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
    const control = fauxToolCall("moondog_spotify_player_control", { action: "resume" });
    const similar = fauxToolCall("moondog_spotify_queue_similar", { count: 3 });
    // Both tools in one batch also obey the sequential failure fence.
    faux.setResponses([fauxAssistantMessage(first === "control" ? [control, similar] : [similar, control], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("UNVERIFIED_SUCCESS")])]);
    const result = await runtime.prompt("Resume playback and queue similar music.");
    assert.equal(calls.filter(call => call === "resume").length, first === "control" ? 1 : 0);
    assert.equal(calls.filter(call => call === "write").length, first === "control" ? 0 : first === "similar_partial" ? 2 : 1);
    assert.doesNotMatch(result.text, /UNVERIFIED_SUCCESS/u);
  });
}
