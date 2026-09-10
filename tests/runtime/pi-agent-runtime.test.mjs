import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import { listAgentCapabilityDescriptors } from "../../src/core/capability-catalog.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import {
  createSyntheticDomainServices,
  DomainServiceError,
} from "../../src/core/synthetic-domain-services.mjs";
import { openLocalMemoryStore } from "../../src/memory/local-memory-store.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";
import { OfflineAgentRuntime } from "../../src/runtime/pi/configured-runtime.mjs";

function fakeApplication() {
  return {
    async sourceStatus() {
      return {
        source: "apple_music_library_xml",
        state: "ready",
        valid_batches: 1,
        invalid_batches: 0,
        latest: { tracks: 3 },
        semantics: {
          library_snapshot_available: true,
          complete_listening_history_available: false,
          profile_materialization_ready: false,
        },
      };
    },
    async profileStatus() {
      return { state: "not_materialized", evidence_records: 0, claims: 0 };
    },
    memoryStatus() {
      return { state: "not_persistent" };
    },
    toolsStatus() {
      return { registry_version: "test/1", capabilities: [] };
    },
    async status(runtime) {
      return {
        product: "moondog",
        runtime,
        source: await this.sourceStatus(),
        profile: await this.profileStatus(),
        memory: this.memoryStatus(),
        external_effects: "disabled",
      };
    },
    agentCapabilityDescriptors() {
      return listAgentCapabilityDescriptors().filter(
        (descriptor) => descriptor.capability_id === "source.apple_music.status",
      );
    },
    beginPrompt() {},
    endPrompt() {},
    resetPromptState() {},
  };
}

function syntheticApplication() {
  return new MoondogApplication({
    importsRoot: "/private/moondog-synthetic-missing-source",
    domainServices: createSyntheticDomainServices({
      subjectScope: { subjectId: "trusted-synthetic-subject" },
    }),
  });
}

function rediscoveryApplication() {
  const track = {
    track_ref_id: "70000000-0000-4000-8000-000000000001",
    title: "Old Signal",
    artist_credit: "Archive Artist",
    release: "Earlier Rooms",
    candidate_scope: "private_history",
    identity_status: "resolved",
    observation_summary: {
      preference_signals: [],
      familiarity: {
        level: "high",
        basis: "effective_listening_history",
        play_count: 24,
      },
    },
    rediscovery: {
      listening_minutes: 96,
      engaged_play_count: 22,
      explicit_skips: 2,
      first_played_at: "2022-02-01T01:00:00.000Z",
      last_played_at: "2024-05-01T01:00:00.000Z",
      quiet_days: 850,
      rediscovery_signal: "saved-library state",
      peak_year: 2023,
      peak_year_play_count: 15,
      peak_year_listening_minutes: 60,
      evidence_id: "30000000-0000-4000-8000-000000000009",
    },
    duration_ms: 240_000,
    external_refs: [
      {
        system: "spotify",
        entity_type: "spotify.track",
        external_id: "PRIVATE_SPOTIFY_ID_MUST_NOT_REACH_MODEL",
      },
    ],
    private_source_path: "/private/history/source.json",
  };
  const candidateSetId = "71000000-0000-4000-8000-000000000001";
  let active = false;
  const domainServices = {
    status() {
      return { state: "ready" };
    },
    profileStatus() {
      return { state: "ready", evidence_records: 1, claims: 0 };
    },
    rediscoveryReady() {
      return true;
    },
    beginPrompt() {
      active = true;
      return { invalidated_candidate_sets: 0 };
    },
    endPrompt() {
      active = false;
      return { invalidated_candidate_sets: 1 };
    },
    resetCandidateSets() {
      active = false;
      return { invalidated_candidate_sets: 1 };
    },
    async searchLibrary() {
      throw new Error("not used in rediscovery test");
    },
    async getProfileSummary() {
      throw new Error("not used in rediscovery test");
    },
    async explainProfileEvidence() {
      throw new Error("not used in rediscovery test");
    },
    async getRediscoveryCandidates() {
      if (!active) throw new Error("candidate scope is not active");
      return {
        state: "ready",
        candidate_set_id: candidateSetId,
        candidate_scope: "private_history",
        result_count: 1,
        limit_applied: 1,
        reference_date: "2026-08-29T04:00:00.000Z",
        quiet_days: 90,
        minimum_plays: 3,
        minimum_engaged_plays: 2,
        minimum_listening_minutes: 10,
        expires_on: "prompt_end",
        tracks: [structuredClone(track)],
      };
    },
    async buildPlaylistPlan(input) {
      if (!active || input.candidateSetIds[0] !== candidateSetId) {
        throw new Error("candidate set unavailable");
      }
      return {
        plan_version: "playlist_plan/0",
        intent: input.intent,
        requested_track_count: input.requestedTrackCount,
        track_count: 1,
        tracks: [
          {
            position: 1,
            track_ref_id: track.track_ref_id,
            title: track.title,
            artist_credit: track.artist_credit,
            release: track.release,
            candidate_scope: "private_history",
            selection_reason: input.trackRefs[0].selectionReason,
          },
        ],
        candidate_scope: "private_history",
        ordering_rationale: input.orderingNotes,
        candidate_sets_validated: 1,
        persistence: "none",
        external_effects: "none",
      };
    },
    getTrustedTracks(trackRefs) {
      if (!active || trackRefs[0] !== track.track_ref_id) {
        throw new Error("track unavailable");
      }
      return [structuredClone(track)];
    },
    registerRetainedPlaylistCandidateSet() {
      active = true;
      return {
        candidate_set_id: candidateSetId,
        candidate_scope: "private_history",
        result_count: 1,
        expires_on: "prompt_end",
        tracks: [structuredClone(track)],
      };
    },
    close() {},
  };
  return new MoondogApplication({
    importsRoot: "/private/moondog-synthetic-missing-source",
    domainServices,
  });
}

function historicalReturnApplication() {
  const track = {
    track_ref_id: "75000000-0000-4000-8000-000000000001",
    title: "Recurring Light",
    artist_credit: "North Window",
    release: "Fictional Return",
    candidate_scope: "private_history",
    identity_status: "resolved",
    observation_summary: {
      preference_signals: [],
      familiarity: {
        level: "medium",
        basis: "effective_listening_history",
        play_count: 8,
      },
    },
    historical_return: {
      listening_minutes: 32,
      engaged_play_count: 8,
      explicit_skips: 0,
      first_played_at: "2020-01-01T00:00:00.000Z",
      last_played_at: "2026-01-01T00:00:00.000Z",
      return_count: 3,
      longest_gap_days: 730,
      latest_return_at: "2026-01-01T00:00:00.000Z",
      latest_return_gap_days: 365,
      historical_return_signal: "historical attention only",
      evidence_id: "76000000-0000-4000-8000-000000000001",
    },
    duration_ms: 240_000,
    external_refs: [
      {
        system: "spotify",
        entity_type: "spotify.track",
        external_id: "PRIVATE_RETURN_ID_MUST_NOT_REACH_MODEL",
      },
    ],
    private_source_path: "/private/history/returns.json",
  };
  const candidateSetId = "77000000-0000-4000-8000-000000000001";
  let active = false;
  const domainServices = {
    status: () => ({ state: "ready" }),
    profileStatus: () => ({ state: "ready", evidence_records: 1, claims: 0 }),
    historicalReturnReady: () => true,
    beginPrompt() {
      active = true;
      return { invalidated_candidate_sets: 0 };
    },
    endPrompt() {
      active = false;
      return { invalidated_candidate_sets: 1 };
    },
    resetCandidateSets() {
      active = false;
      return { invalidated_candidate_sets: 1 };
    },
    async searchLibrary() {
      throw new Error("not used in historical-return test");
    },
    async getProfileSummary() {
      throw new Error("not used in historical-return test");
    },
    async explainProfileEvidence() {
      throw new Error("not used in historical-return test");
    },
    async getHistoricalReturnCandidates() {
      if (!active) throw new Error("candidate scope is not active");
      return {
        state: "ready",
        candidate_set_id: candidateSetId,
        candidate_scope: "private_history",
        result_count: 1,
        limit_applied: 1,
        reference_date: "2026-08-29T04:00:00.000Z",
        minimum_gap_days: 180,
        minimum_plays: 3,
        minimum_engaged_plays: 3,
        minimum_listening_minutes: 10,
        expires_on: "prompt_end",
        tracks: [structuredClone(track)],
      };
    },
    async buildPlaylistPlan(input) {
      if (!active || input.candidateSetIds[0] !== candidateSetId) {
        throw new Error("candidate set unavailable");
      }
      return {
        plan_version: "playlist_plan/0",
        intent: input.intent,
        requested_track_count: input.requestedTrackCount,
        track_count: 1,
        tracks: [
          {
            position: 1,
            track_ref_id: track.track_ref_id,
            title: track.title,
            artist_credit: track.artist_credit,
            release: track.release,
            candidate_scope: "private_history",
            selection_reason: input.trackRefs[0].selectionReason,
            history_context: { kind: "historical_return" },
          },
        ],
        candidate_scope: "private_history",
        ordering_rationale: input.orderingNotes,
        candidate_sets_validated: 1,
        persistence: "none",
        external_effects: "none",
      };
    },
    getTrustedTracks(trackRefs) {
      if (!active || trackRefs[0] !== track.track_ref_id) {
        throw new Error("track unavailable");
      }
      return [structuredClone(track)];
    },
    registerRetainedPlaylistCandidateSet() {
      active = true;
      return {
        candidate_set_id: candidateSetId,
        candidate_scope: "private_history",
        result_count: 1,
        expires_on: "prompt_end",
        tracks: [structuredClone(track)],
      };
    },
    close() {},
  };
  return new MoondogApplication({
    importsRoot: "/private/moondog-synthetic-missing-source",
    domainServices,
  });
}

function backToBackApplication() {
  const track = {
    track_ref_id: "78000000-0000-4000-8000-000000000001",
    title: "Fictional Echo",
    artist_credit: "Sequence Study",
    release: "Synthetic Playback",
    candidate_scope: "private_history",
    identity_status: "resolved",
    observation_summary: {
      preference_signals: [],
      familiarity: {
        level: "medium",
        basis: "effective_listening_history",
        play_count: 9,
      },
    },
    back_to_back: {
      engaged_play_count: 9,
      explicit_skips: 0,
      burst_count: 2,
      maximum_consecutive_plays: 4,
      plays_in_bursts: 7,
      listening_minutes_in_bursts: 28,
      latest_burst_at: "2026-08-01T12:00:00.000Z",
      sequence_signal: "adjacent retained plays",
      evidence_id: "79000000-0000-4000-8000-000000000001",
    },
    duration_ms: 240_000,
    external_refs: [
      {
        system: "spotify",
        entity_type: "spotify.track",
        external_id: "PRIVATE_BACK_TO_BACK_ID_MUST_NOT_REACH_MODEL",
      },
    ],
    private_source_path: "/private/history/back-to-back.json",
  };
  const candidateSetId = "7a000000-0000-4000-8000-000000000001";
  let active = false;
  const domainServices = {
    status: () => ({ state: "ready" }),
    profileStatus: () => ({ state: "ready", evidence_records: 1, claims: 0 }),
    backToBackReady: () => true,
    beginPrompt() {
      active = true;
      return { invalidated_candidate_sets: 0 };
    },
    endPrompt() {
      active = false;
      return { invalidated_candidate_sets: 1 };
    },
    resetCandidateSets() {
      active = false;
      return { invalidated_candidate_sets: 1 };
    },
    async searchLibrary() {
      throw new Error("not used in back-to-back test");
    },
    async getProfileSummary() {
      throw new Error("not used in back-to-back test");
    },
    async explainProfileEvidence() {
      throw new Error("not used in back-to-back test");
    },
    async getBackToBackCandidates() {
      if (!active) throw new Error("candidate scope is not active");
      return {
        state: "ready",
        candidate_set_id: candidateSetId,
        candidate_scope: "private_history",
        result_count: 1,
        limit_applied: 1,
        reference_date: "2026-08-29T04:00:00.000Z",
        minimum_consecutive_plays: 2,
        minimum_played_seconds: 30,
        maximum_gap_minutes: 30,
        expires_on: "prompt_end",
        tracks: [structuredClone(track)],
      };
    },
    async buildPlaylistPlan(input) {
      if (!active || input.candidateSetIds[0] !== candidateSetId) {
        throw new Error("candidate set unavailable");
      }
      return {
        plan_version: "playlist_plan/0",
        intent: input.intent,
        requested_track_count: input.requestedTrackCount,
        track_count: 1,
        tracks: [
          {
            position: 1,
            track_ref_id: track.track_ref_id,
            title: track.title,
            artist_credit: track.artist_credit,
            release: track.release,
            candidate_scope: "private_history",
            selection_reason: input.trackRefs[0].selectionReason,
            history_context: { kind: "back_to_back" },
          },
        ],
        candidate_scope: "private_history",
        ordering_rationale: input.orderingNotes,
        candidate_sets_validated: 1,
        persistence: "none",
        external_effects: "none",
      };
    },
    getTrustedTracks(trackRefs) {
      if (!active || trackRefs[0] !== track.track_ref_id) {
        throw new Error("track unavailable");
      }
      return [structuredClone(track)];
    },
    registerRetainedPlaylistCandidateSet() {
      active = true;
      return {
        candidate_set_id: candidateSetId,
        candidate_scope: "private_history",
        result_count: 1,
        expires_on: "prompt_end",
        tracks: [structuredClone(track)],
      };
    },
    close() {},
  };
  return new MoondogApplication({
    importsRoot: "/private/moondog-synthetic-missing-source",
    domainServices,
  });
}

function timeCapsuleApplication() {
  const years = [2018, 2022, 2026];
  const tracks = years.map((year, index) => ({
    track_ref_id: `72000000-0000-4000-8000-00000000000${index + 1}`,
    title: ["First Light", "Middle Distance", "Present Tense"][index],
    artist_credit: ["Early Artist", "Middle Artist", "Present Artist"][index],
    release: `Fictional Release ${index + 1}`,
    candidate_scope: "private_history",
    identity_status: "resolved",
    observation_summary: {
      preference_signals: [],
      familiarity: {
        level: "medium",
        basis: "effective_listening_history",
        play_count: 8,
      },
    },
    time_capsule: {
      year,
      year_play_count: 5,
      year_engaged_play_count: 5,
      year_listening_minutes: 20,
      year_explicit_skips: 0,
      lifetime_listening_minutes: 32,
      representative_signal: "historical attention only",
      evidence_id: `73000000-0000-4000-8000-00000000000${index + 1}`,
    },
    duration_ms: 240_000,
    external_refs: [
      {
        system: "spotify",
        entity_type: "spotify.track",
        external_id: `PRIVATE_TIME_CAPSULE_ID_${index + 1}`,
      },
    ],
    private_source_path: `/private/history/year-${year}.json`,
  }));
  const candidateSetId = "74000000-0000-4000-8000-000000000001";
  let active = false;
  const domainServices = {
    status: () => ({ state: "ready" }),
    profileStatus: () => ({ state: "ready", evidence_records: 3, claims: 0 }),
    timeCapsuleReady: () => true,
    beginPrompt() {
      active = true;
      return { invalidated_candidate_sets: 0 };
    },
    endPrompt() {
      active = false;
      return { invalidated_candidate_sets: 1 };
    },
    resetCandidateSets() {
      active = false;
      return { invalidated_candidate_sets: 1 };
    },
    async searchLibrary() {
      throw new Error("not used in time capsule test");
    },
    async getProfileSummary() {
      throw new Error("not used in time capsule test");
    },
    async explainProfileEvidence() {
      throw new Error("not used in time capsule test");
    },
    async getTimeCapsuleCandidates() {
      if (!active) throw new Error("candidate scope is not active");
      return {
        state: "ready",
        candidate_set_id: candidateSetId,
        candidate_scope: "private_history",
        result_count: tracks.length,
        limit_applied: tracks.length,
        reference_date: "2026-08-29T04:00:00.000Z",
        history_start_year: 2018,
        history_end_year: 2026,
        represented_years: years,
        minimum_years: 2,
        minimum_engaged_plays: 2,
        minimum_listening_minutes: 5,
        expires_on: "prompt_end",
        tracks: structuredClone(tracks),
      };
    },
    async buildPlaylistPlan(input) {
      if (!active || input.candidateSetIds[0] !== candidateSetId) {
        throw new Error("candidate set unavailable");
      }
      return {
        plan_version: "playlist_plan/0",
        intent: input.intent,
        requested_track_count: input.requestedTrackCount,
        track_count: tracks.length,
        tracks: tracks.map((track, index) => ({
          position: index + 1,
          track_ref_id: track.track_ref_id,
          title: track.title,
          artist_credit: track.artist_credit,
          release: track.release,
          candidate_scope: "private_history",
          selection_reason: input.trackRefs[index].selectionReason,
          history_context: {
            kind: "time_capsule",
            year: track.time_capsule.year,
          },
        })),
        candidate_scope: "private_history",
        ordering_rationale: input.orderingNotes,
        candidate_sets_validated: 1,
        persistence: "none",
        external_effects: "none",
      };
    },
    getTrustedTracks(trackRefs) {
      if (
        !active ||
        trackRefs.some((ref, index) => ref !== tracks[index].track_ref_id)
      ) {
        throw new Error("track unavailable");
      }
      return structuredClone(tracks);
    },
    registerRetainedPlaylistCandidateSet() {
      active = true;
      return {
        candidate_set_id: candidateSetId,
        candidate_scope: "private_history",
        result_count: tracks.length,
        expires_on: "prompt_end",
        tracks: structuredClone(tracks),
      };
    },
    close() {},
  };
  return new MoondogApplication({
    importsRoot: "/private/moondog-synthetic-missing-source",
    domainServices,
  });
}

function configuredRuntime(application, faux = fauxProvider()) {
  const models = createModels();
  models.setProvider(faux.provider);
  return {
    faux,
    runtime: new PiAgentRuntime({
      application,
      models,
      model: faux.getModel(),
      provider: "faux",
      modelId: "faux-1",
    }),
  };
}

async function withPersistentApplication(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-runtime-memory-"));
  const memoryStore = await openLocalMemoryStore({
    databasePath: path.join(root, "memory.sqlite"),
  });
  const application = new MoondogApplication({
    importsRoot: "/private/moondog-synthetic-missing-source",
    domainServices: createSyntheticDomainServices({
      subjectScope: { subjectId: "trusted-synthetic-subject" },
    }),
    memoryStore,
  });
  try {
    return await callback(application);
  } finally {
    application.close();
    await rm(root, { recursive: true, force: true });
  }
}

function toolResults(context, toolName) {
  return context.messages
    .filter(
      (message) =>
        message.role === "toolResult" && message.toolName === toolName,
    )
    .map((message) => JSON.parse(message.content[0].text));
}

test("Pi adapter executes a trusted read-only diagnostic tool", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_source_status", {})],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("The local snapshot is ready.")]),
  ]);

  const runtime = new PiAgentRuntime({
    application: fakeApplication(),
    models,
    model: faux.getModel(),
    provider: "faux",
    modelId: "faux-1",
  });
  const startedTools = [];
  const result = await runtime.prompt("Check the source.", {
    onToolStart: (name) => startedTools.push(name),
  });

  assert.equal(result.text, "The local snapshot is ready.");
  assert.deepEqual(
    startedTools.map((tool) => tool.toolName),
    ["moondog_source_status"],
  );
  assert.equal(faux.state.callCount, 2);
  assert.equal(runtime.publicStatus().external_effects, "disabled");
});

test("Pi adapter exposes metadata-free Spotify status and one-shot controls when connected", async () => {
  const calls = [];
  const application = new MoondogApplication({
    importsRoot: "/private/moondog-synthetic-missing-source",
    spotifyConnection: {
      ready: () => true,
      publicStatus: () => ({
        provider: "spotify",
        state: "ready",
        external_effects: "spotify_control",
      }),
      service: {
        async currentPlayer() {
          return {
            provider: "spotify",
            state: "available",
            is_playing: true,
            shuffle_state: false,
            repeat_state: "off",
            currently_playing_type: "track",
            device: {
              id: "PRIVATE_DEVICE_ID",
              name: "PRIVATE_DEVICE_NAME",
              is_active: true,
              is_restricted: false,
            },
            item: {
              name: "PRIVATE_TRACK_NAME",
              uri: "spotify:track:PrivateTrack",
            },
          };
        },
        async pause(input) {
          calls.push(input);
          return {
            provider: "spotify",
            ok: true,
            effect: "write_external",
            action: "playback.pause",
            state: "accepted",
          };
        },
      },
    },
  });
  const faux = fauxProvider();
  const { runtime } = configuredRuntime(application, faux);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_spotify_player_status", {})],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [player] = toolResults(
        context,
        "moondog_spotify_player_status",
      );
      const serialized = JSON.stringify(player);
      assert.equal(serialized.includes("PRIVATE_"), false);
      assert.equal(player.item_available, true);
      return fauxAssistantMessage(
        [fauxToolCall("moondog_spotify_player_control", { action: "pause" })],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const [receipt] = toolResults(
        context,
        "moondog_spotify_player_control",
      );
      assert.deepEqual(receipt, {
        provider: "spotify",
        ok: true,
        effect: "write_external",
        action: "playback.pause",
        state: "accepted",
      });
      return fauxAssistantMessage([fauxText("Paused Spotify.")]);
    },
  ]);

  const result = await runtime.prompt("Pause my Spotify playback.");

  assert.equal(result.text, "Paused Spotify.");
  assert.equal(runtime.publicStatus().external_effects, "spotify_control");
  assert.deepEqual(calls, [{}]);
});

test("offline runtime fails explicitly instead of pretending to converse", async () => {
  const runtime = new OfflineAgentRuntime();

  assert.equal(runtime.publicStatus().state, "offline");
  await assert.rejects(runtime.prompt("hello"), /model runtime is offline/i);
});

test("Pi adapter discards a model failure and accepts a later prompt", async () => {
  const { faux, runtime } = configuredRuntime(fakeApplication());
  faux.setResponses([
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "Synthetic provider outage.",
    }),
    fauxAssistantMessage([fauxText("The model recovered on the next prompt.")]),
  ]);

  await assert.rejects(runtime.prompt("Fail this turn."), /provider outage/iu);
  assert.deepEqual(runtime.agent.state.messages, []);

  const recovered = await runtime.prompt("Try again.");
  assert.equal(recovered.text, "The model recovered on the next prompt.");
});

test("Pi adapter redacts credential-bearing Codex provider failures", async () => {
  const { faux, runtime } = configuredRuntime(fakeApplication());
  runtime.runtimeStatus.provider = "openai-codex";
  faux.setResponses([
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage:
        'OAuth refresh failed: {"access_token":"ACCESS_TOKEN_SENTINEL","refresh_token":"REFRESH_TOKEN_SENTINEL"}',
    }),
  ]);

  await assert.rejects(
    runtime.prompt("Refresh the model credential."),
    (error) =>
      /auth login openai-codex/iu.test(error.message) &&
      !error.message.includes("TOKEN_SENTINEL"),
  );
});

test("Pi adapter returns an aborted outcome and preserves streamed text", async () => {
  const faux = fauxProvider({
    tokensPerSecond: 20,
    tokenSize: { min: 1, max: 1 },
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxText("partial response that will be cancelled")]),
  ]);

  const runtime = new PiAgentRuntime({
    application: fakeApplication(),
    models,
    model: faux.getModel(),
    provider: "faux",
    modelId: "faux-1",
  });
  let streamed = "";
  const result = await runtime.prompt("Start a response.", {
    onTextDelta(delta) {
      streamed += delta;
      if (streamed.length >= 3) runtime.abort();
    },
  });

  assert.equal(result.status, "aborted");
  assert.ok(streamed.length >= 3);
  assert.ok(result.text.startsWith(streamed));
  assert.doesNotMatch(result.text, /Runtime error|Request was aborted/);
});

test("memory mutations commit only with a completed authoritative turn", async () => {
  await withPersistentApplication(async (application) => {
    const faux = fauxProvider({
      tokensPerSecond: 40,
      tokenSize: { min: 1, max: 1 },
    });
    const { runtime } = configuredRuntime(application, faux);
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("moondog_memory_remember", {
            text: "Prefers concise technical explanations",
            kind: "preference",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("I will remember that.")]),
      fauxAssistantMessage(
        [
          fauxToolCall("moondog_memory_remember", {
            text: "This memory must disappear when the turn is aborted",
            kind: "fact",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([
        fauxText("This response will be cancelled before it completes."),
      ]),
      fauxAssistantMessage(
        [
          fauxToolCall("moondog_memory_remember", {
            text: "This memory must fail with the SQLite commit",
            kind: "fact",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("I will remember this too.")]),
    ]);

    const completed = await runtime.prompt("Please remember this preference.");
    assert.equal(completed.status, "completed");
    assert.equal(completed.memory_recorded, true);
    assert.equal(application.memorySummary().memories.length, 1);
    assert.equal(application.memoryStatus().turns, 2);

    let streamed = "";
    const aborted = await runtime.prompt("Remember this, then keep talking.", {
      onTextDelta(delta) {
        streamed += delta;
        if (streamed.length >= 3) runtime.abort();
      },
      onTextReplace() {},
    });
    assert.equal(aborted.status, "aborted");
    assert.equal(application.memorySummary().memories.length, 1);
    assert.equal(application.memoryStatus().turns, 2);

    application.commitCompletedPrompt = () => {
      throw new Error("synthetic memory store failure");
    };
    const failed = await runtime.prompt("Remember one more fact.");
    assert.match(failed.text, /memory was not saved/iu);
    assert.equal(failed.memory_recorded, false);
    assert.equal(application.memorySummary().memories.length, 1);
  });
});

test("A1 faux model completes profile, search, evidence, and playlist tools", async () => {
  const application = syntheticApplication();
  const { faux, runtime } = configuredRuntime(application);
  const familiarityEvidenceId = "20000000-0000-4000-8000-000000000003";
  let capturedCandidateSets = [];
  let capturedTrackRefs = [];

  faux.setResponses([
    (context) => {
      const serializedContext = JSON.stringify(context);
      assert.equal(
        serializedContext.includes("trusted-synthetic-subject"),
        false,
      );
      assert.equal(serializedContext.includes("synthetic-provider-private"), false);
      assert.equal(serializedContext.includes("/private/synthetic/library"), false);
      return fauxAssistantMessage(
        [fauxToolCall("moondog_profile_summary", { max_items: 6 })],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage(
      [
        fauxToolCall("moondog_library_search", {
          limit: 3,
          filters: { familiarity: ["high", "medium"] },
        }),
        fauxToolCall("moondog_library_search", {
          query: "",
          limit: 3,
          filters: { familiarity: ["low", "unknown"] },
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        fauxToolCall("moondog_profile_explain", {
          evidence_id: familiarityEvidenceId,
        }),
      ],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const searches = toolResults(context, "moondog_library_search");
      capturedCandidateSets = searches.map((result) => result.candidate_set_id);
      capturedTrackRefs = searches.flatMap((result) => result.tracks);
      assert.equal(capturedCandidateSets.length, 2);
      assert.equal(capturedTrackRefs.length, 6);
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_playlist_plan", {
            intent: "适合晚上独自坐车，从熟悉过渡到一点意外感。",
            requested_track_count: 6,
            candidate_set_ids: capturedCandidateSets,
            track_refs: capturedTrackRefs.map((track, index) => ({
              track_ref_id: track.track_ref_id,
              selection_reason:
                index < 3
                  ? "A familiar opening grounded in play-count evidence."
                  : "A lower-familiarity turn that adds bounded surprise.",
            })),
            ordering_notes:
              "Move from high and medium familiarity toward lower-familiarity tracks.",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage([
      fauxText("Here is a grounded six-track plan from your library."),
    ]),
  ]);

  const starts = [];
  const ends = [];
  const result = await runtime.prompt("Plan six night-drive tracks.", {
    onToolStart: (tool) => starts.push(tool),
    onToolEnd: (tool) => ends.push(tool),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.playlist_plan.track_count, 6);
  assert.equal(result.playlist_plan.requested_track_count, 6);
  assert.equal("music_world_citations" in result, false);
  assert.match(result.text, /6-track plan from your library/u);
  assert.equal(
    result.text.includes("Here is a grounded six-track plan from your library."),
    false,
  );
  assert.equal(
    result.playlist_plan.tracks.every((track) =>
      result.text.includes(track.title),
    ),
    true,
  );
  assert.deepEqual(
    starts.map((tool) => tool.toolName),
    [
      "moondog_profile_summary",
      "moondog_library_search",
      "moondog_library_search",
      "moondog_profile_explain",
      "moondog_playlist_plan",
    ],
  );
  assert.ok(starts.every((tool) => tool.label && tool.capabilityId));
  assert.ok(ends.every((tool) => tool.isError === false));
  assert.equal(faux.state.callCount, 5);

  await assert.rejects(
    application.buildPlaylistPlan({
      intent: "6 tracks",
      candidateSetIds: capturedCandidateSets,
      trackRefs: capturedTrackRefs.map((track) => ({
        trackRefId: track.track_ref_id,
        selectionReason: "stale",
      })),
      orderingNotes: "stale candidate sets",
    }),
    (error) =>
      error instanceof DomainServiceError &&
      error.code === "candidate_set_unavailable",
  );
});

test("rediscovery tool creates a safe private-history candidate set and authoritative plan", async () => {
  const application = rediscoveryApplication();
  const { faux, runtime } = configuredRuntime(application);
  let candidateSet;
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_rediscovery_candidates", { limit: 1 })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [rediscovery] = toolResults(
        context,
        "moondog_rediscovery_candidates",
      );
      candidateSet = rediscovery;
      assert.equal(rediscovery.state, "ready");
      assert.equal(rediscovery.candidate_scope, "private_history");
      assert.equal(rediscovery.tracks[0].title, "Old Signal");
      assert.equal(rediscovery.tracks[0].quiet_days, 850);
      assert.equal(rediscovery.tracks[0].peak_year, 2023);
      assert.equal("external_refs" in rediscovery.tracks[0], false);
      assert.doesNotMatch(JSON.stringify(rediscovery), /PRIVATE_|spotify:/u);
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_playlist_plan", {
            intent: "找 1 首值得再听一次的旧歌。",
            requested_track_count: 1,
            candidate_set_ids: [rediscovery.candidate_set_id],
            track_refs: [
              {
                track_ref_id: rediscovery.tracks[0].track_ref_id,
                selection_reason: "过去投入明显，并已超过有边界的安静窗口。",
              },
            ],
            ordering_notes: "单曲重逢，不需要额外过渡。",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage([fauxText("An untrusted model draft.")]),
  ]);

  const starts = [];
  const result = await runtime.prompt("找 1 首值得再听一次的旧歌。", {
    onToolStart: (tool) => starts.push(tool.toolName),
  });

  assert.equal(candidateSet.result_count, 1);
  assert.deepEqual(starts, [
    "moondog_rediscovery_candidates",
    "moondog_playlist_plan",
  ]);
  assert.equal(result.playlist_plan.candidate_scope, "private_history");
  assert.match(result.text, /历史重逢方案/u);
  assert.match(result.text, /尚未写入 Spotify/u);
  assert.doesNotMatch(result.text, /新颖性边界/u);
  assert.doesNotMatch(result.text, /PRIVATE_|spotify:/u);
  application.close();
});

test("historical-return tool creates a private recurrence plan without provider identity", async () => {
  const application = historicalReturnApplication();
  const { faux, runtime } = configuredRuntime(application);
  let candidateSet;
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_historical_return_candidates", { limit: 1 })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [historicalReturns] = toolResults(
        context,
        "moondog_historical_return_candidates",
      );
      candidateSet = historicalReturns;
      assert.equal(historicalReturns.state, "ready");
      assert.equal(historicalReturns.candidate_scope, "private_history");
      assert.equal(historicalReturns.tracks[0].title, "Recurring Light");
      assert.equal(historicalReturns.tracks[0].return_count, 3);
      assert.equal(historicalReturns.tracks[0].longest_gap_days, 730);
      assert.equal("external_refs" in historicalReturns.tracks[0], false);
      assert.doesNotMatch(
        JSON.stringify(historicalReturns),
        /PRIVATE_|spotify:|\/private\//u,
      );
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_playlist_plan", {
            intent: "找 1 首曾经隔很久又回来的歌。",
            requested_track_count: 1,
            candidate_set_ids: [historicalReturns.candidate_set_id],
            track_refs: [
              {
                track_ref_id: historicalReturns.tracks[0].track_ref_id,
                selection_reason: "它在长期空档后多次重新出现在保留历史里。",
              },
            ],
            ordering_notes: "单曲回归路径。",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage([fauxText("An untrusted model draft.")]),
  ]);

  const starts = [];
  const result = await runtime.prompt("找 1 首曾经隔很久又回来的歌。", {
    onToolStart: (tool) => starts.push(tool.toolName),
  });

  assert.equal(candidateSet.result_count, 1);
  assert.deepEqual(starts, [
    "moondog_historical_return_candidates",
    "moondog_playlist_plan",
  ]);
  assert.equal(
    result.playlist_plan.tracks[0].history_context.kind,
    "historical_return",
  );
  assert.match(result.text, /长久空档后重新出现/u);
  assert.match(result.text, /尚未写入 Spotify/u);
  assert.doesNotMatch(result.text, /PRIVATE_|spotify:|\/private\//u);
  application.close();
});

test("back-to-back tool creates a bounded sequence plan without inferring intent", async () => {
  const application = backToBackApplication();
  const { faux, runtime } = configuredRuntime(application);
  let candidateSet;
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_back_to_back_candidates", { limit: 1 })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [backToBack] = toolResults(
        context,
        "moondog_back_to_back_candidates",
      );
      candidateSet = backToBack;
      assert.equal(backToBack.state, "ready");
      assert.equal(backToBack.candidate_scope, "private_history");
      assert.equal(backToBack.tracks[0].title, "Fictional Echo");
      assert.equal(backToBack.tracks[0].burst_count, 2);
      assert.equal(backToBack.tracks[0].maximum_consecutive_plays, 4);
      assert.equal(backToBack.tracks[0].plays_in_bursts, 7);
      assert.equal("external_refs" in backToBack.tracks[0], false);
      assert.match(backToBack.interpretation_limit, /does not prove repeat mode/iu);
      assert.doesNotMatch(
        JSON.stringify(backToBack),
        /PRIVATE_|spotify:|\/private\//u,
      );
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_playlist_plan", {
            intent: "找 1 首曾被连续播放的歌。",
            requested_track_count: 1,
            candidate_set_ids: [backToBack.candidate_set_id],
            track_refs: [
              {
                track_ref_id: backToBack.tracks[0].track_ref_id,
                selection_reason: "它出现在有边界的相邻同曲播放序列里。",
              },
            ],
            ordering_notes: "单曲序列证据。",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage([fauxText("An untrusted model draft.")]),
  ]);

  const starts = [];
  const result = await runtime.prompt("找 1 首我曾经连续播放的歌。", {
    onToolStart: (tool) => starts.push(tool.toolName),
  });

  assert.equal(candidateSet.result_count, 1);
  assert.deepEqual(starts, [
    "moondog_back_to_back_candidates",
    "moondog_playlist_plan",
  ]);
  assert.equal(
    result.playlist_plan.tracks[0].history_context.kind,
    "back_to_back",
  );
  assert.match(result.text, /曾被连续播放的历史片段方案/u);
  assert.match(result.text, /不证明当时开启了循环/u);
  assert.match(result.text, /尚未写入 Spotify/u);
  assert.doesNotMatch(result.text, /PRIVATE_|spotify:|\/private\//u);
  application.close();
});

test("Time Machine tool creates a chronological private-history plan", async () => {
  const application = timeCapsuleApplication();
  const { faux, runtime } = configuredRuntime(application);
  let candidateSet;
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_time_capsule_candidates", { limit: 3 })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [timeCapsule] = toolResults(
        context,
        "moondog_time_capsule_candidates",
      );
      candidateSet = timeCapsule;
      assert.equal(timeCapsule.state, "ready");
      assert.deepEqual(timeCapsule.represented_years, [2018, 2022, 2026]);
      assert.equal(timeCapsule.tracks[0].title, "First Light");
      assert.equal(timeCapsule.tracks[0].year, 2018);
      assert.equal("external_refs" in timeCapsule.tracks[0], false);
      assert.doesNotMatch(JSON.stringify(timeCapsule), /PRIVATE_|\/private\//u);
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_playlist_plan", {
            intent: "做一个 3 首跨年份听歌时间机器。",
            requested_track_count: 3,
            candidate_set_ids: [timeCapsule.candidate_set_id],
            track_refs: timeCapsule.tracks.map((track) => ({
              track_ref_id: track.track_ref_id,
              selection_reason: `${track.year} 年的有边界历史地标。`,
            })),
            ordering_notes: "按年份从早到晚推进。",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage([fauxText("An untrusted model draft.")]),
  ]);

  const starts = [];
  const result = await runtime.prompt("做一个 3 首跨年份听歌时间机器。", {
    onToolStart: (tool) => starts.push(tool.toolName),
  });

  assert.equal(candidateSet.result_count, 3);
  assert.deepEqual(starts, [
    "moondog_time_capsule_candidates",
    "moondog_playlist_plan",
  ]);
  assert.equal(result.playlist_plan.candidate_scope, "private_history");
  assert.match(result.text, /穿过 3 个听歌年份的时间机器方案/u);
  assert.match(result.text, /2018 · First Light/u);
  assert.match(result.text, /2026 · Present Tense/u);
  assert.match(result.text, /尚未写入 Spotify/u);
  assert.doesNotMatch(result.text, /PRIVATE_|\/private\//u);
  application.close();
});

test("profile tool projects private Spotify behavior and curation into model context", async () => {
  const base = createSyntheticDomainServices({
    subjectScope: { subjectId: "trusted-synthetic-subject" },
  });
  const evidenceId = "30000000-0000-4000-8000-000000000001";
  let listenerAssertions;
  const domainServices = {
    status: () => base.status(),
    profileStatus: () => base.profileStatus(),
    beginPrompt: () => base.beginPrompt(),
    endPrompt: () => base.endPrompt(),
    resetCandidateSets: () => base.resetCandidateSets(),
    searchLibrary: (input) => base.searchLibrary(input),
    getTrustedTracks: (ids) => base.getTrustedTracks(ids),
    buildPlaylistPlan: (input) => base.buildPlaylistPlan(input),
    explainProfileEvidence: (input) => base.explainProfileEvidence(input),
    async getProfileSummary(input) {
      const summary = await base.getProfileSummary(input);
      return {
        ...summary,
        profile_version: "profile-projection/1",
        coverage: {
          ...summary.coverage,
          effective_listening_events: 12,
          profiled_listening_events: 11,
          listening_hours: 1.5,
          listening_tracks: 4,
          resolved_listening_tracks: 4,
          spotify_profile_evidence: 3,
          spotify_saved_tracks: 1,
          spotify_saved_albums: 1,
          spotify_followed_artists: 1,
          spotify_playlist_memberships: 1,
          verified_search_interactions: 1,
        },
        listening_behavior: {
          enduring_artists: [
            {
              name: "Spotify Artist",
              play_count: 12,
              engaged_play_count: 11,
              listening_minutes: 90,
              distinct_tracks: 4,
              explicit_skips: 1,
              last_played_at: "2026-08-29T04:00:00.000Z",
              evidence_id: evidenceId,
            },
          ],
          recent_artists: [],
          repeat_tracks: [],
          recent_tracks: [],
          rediscovery_tracks: [
            {
              track_ref_id: "10000000-0000-4000-8000-000000000002",
              label: "Quiet Coordinates",
              artist_credit: "Sable Arcade",
              release: "Night Survey",
              identity_status: "resolved",
              play_count: 18,
              engaged_play_count: 16,
              listening_minutes: 92,
              explicit_skips: 2,
              first_played_at: "2024-01-12T00:00:00.000Z",
              last_played_at: "2025-12-31T00:00:00.000Z",
              quiet_days: 241,
              peak_year: 2024,
              peak_year_play_count: 12,
              peak_year_listening_minutes: 61,
              rediscovery_signal: "saved-library state",
              evidence_id: evidenceId,
            },
          ],
          historical_return_tracks: [
            {
              track_ref_id: "10000000-0000-4000-8000-000000000003",
              label: "Recurring Light",
              artist_credit: "North Window",
              release: "Fictional Return",
              identity_status: "resolved",
              play_count: 8,
              engaged_play_count: 8,
              listening_minutes: 32,
              explicit_skips: 0,
              first_played_at: "2020-01-01T00:00:00.000Z",
              last_played_at: "2026-01-01T00:00:00.000Z",
              return_count: 3,
              longest_gap_days: 730,
              latest_return_at: "2026-01-01T00:00:00.000Z",
              latest_return_gap_days: 365,
              historical_return_signal: "historical attention only",
              evidence_id: evidenceId,
            },
          ],
          history_arc: [
            {
              year: 2026,
              event_count: 8,
              listening_minutes: 32,
              distinct_tracks: 3,
              first_observed_tracks: 1,
              top_artist: {
                name: "North Window",
                play_count: 5,
                listening_minutes: 20,
              },
            },
          ],
          listening_seasons: {
            timezone: "UTC",
            alignment: "calendar_quarter",
            season_length_months: 3,
            retained_first_season: "2026-Q1",
            represented_first_season: "2026-Q1",
            last_season: "2026-Q3",
            retained_season_count: 3,
            represented_season_count: 3,
            active_season_count: 2,
            represented_active_season_count: 2,
            omitted_earlier_season_count: 0,
            omitted_earlier_active_season_count: 0,
            seasons: [
              {
                key: "2026-Q1",
                start_month: "2026-01",
                end_month: "2026-03",
                retained_month_count: 3,
                active_month_count: 2,
                event_count: 5,
                engaged_play_count: 4,
                listening_minutes: 20,
                distinct_tracks: 3,
                first_observed_tracks: 2,
                returning_tracks: 1,
                leading_artist: {
                  name: "North Window",
                  event_count: 3,
                  engaged_play_count: 3,
                  listening_minutes: 12,
                  distinct_tracks: 2,
                },
                signature_track: {
                  track_ref_id: "10000000-0000-4000-8000-000000000004",
                  label: "Quarter Signal",
                  artist_credit: "North Window",
                  release: "Fictional Return",
                  play_count: 2,
                  engaged_play_count: 2,
                  listening_minutes: 8,
                  explicit_skips: 0,
                },
              },
              {
                key: "2026-Q2",
                start_month: "2026-04",
                end_month: "2026-06",
                retained_month_count: 3,
                active_month_count: 0,
                event_count: 0,
                engaged_play_count: 0,
                listening_minutes: 0,
                distinct_tracks: 0,
                first_observed_tracks: 0,
                returning_tracks: 0,
              },
              {
                key: "2026-Q3",
                start_month: "2026-07",
                end_month: "2026-08",
                retained_month_count: 2,
                active_month_count: 2,
                event_count: 3,
                engaged_play_count: 3,
                listening_minutes: 12,
                distinct_tracks: 2,
                first_observed_tracks: 1,
                returning_tracks: 1,
                leading_artist: {
                  name: "Present Signal",
                  event_count: 3,
                  engaged_play_count: 3,
                  listening_minutes: 12,
                  distinct_tracks: 2,
                },
                signature_track: {
                  track_ref_id: "10000000-0000-4000-8000-000000000005",
                  label: "Current Quarter",
                  artist_credit: "Present Signal",
                  play_count: 2,
                  engaged_play_count: 2,
                  listening_minutes: 8,
                  explicit_skips: 0,
                },
              },
            ],
            evidence_id: evidenceId,
          },
          artist_relationships: [
            {
              name: "North Window",
              first_year: 2020,
              last_year: 2026,
              active_years: 4,
              span_years: 7,
              play_count: 8,
              listening_minutes: 32,
              evidence_id: evidenceId,
            },
          ],
          year_transitions: [
            {
              from_year: 2025,
              to_year: 2026,
              artist_limit: 10,
              from_artist_count: 2,
              to_artist_count: 2,
              retained_artist_count: 1,
              new_artist_count: 1,
              continuity_percent: 50,
              retained_artists: ["North Window"],
              new_artists: ["New Signal"],
              evidence_id: evidenceId,
            },
          ],
          release_depth: [
            {
              title: "Fictional Return",
              artist_credit: "North Window",
              distinct_tracks: 3,
              play_count: 8,
              engaged_play_count: 8,
              listening_minutes: 32,
              first_year: 2020,
              last_year: 2026,
              active_years: 4,
              evidence_id: evidenceId,
            },
          ],
          session_summary: {
            source: "spotify_extended_history",
            method: "track_stop_gap",
            gap_minutes: 30,
            event_count: 8,
            session_count: 3,
            median_plays: 2,
            median_listening_minutes: 8,
            single_play_sessions: 1,
            short_sequence_sessions: 1,
            extended_sequence_sessions: 1,
            extended_sequence_minimum_plays: 5,
            extended_sequence_percent: 33.3,
            evidence_id: evidenceId,
          },
          context: {
            reference_date: "2026-08-29T04:00:00.000Z",
            recent_window_days: 90,
            effective_events_profiled: 11,
            start_reason_events: 10,
            trackdone_starts: 6,
            end_reason_events: 10,
            skip_state_events: 10,
            explicit_skips: 1,
            trackdone_endings: 8,
            direct_selection_starts: 3,
            shuffle_state_events: 10,
            shuffle_events: 2,
            offline_state_events: 10,
            offline_events: 1,
            incognito_events_excluded: 1,
            rediscovery_quiet_days: 90,
            rediscovery_minimum_plays: 3,
            rediscovery_minimum_engaged_plays: 2,
            rediscovery_minimum_listening_minutes: 10,
            historical_return_minimum_gap_days: 180,
            historical_return_minimum_plays: 3,
            historical_return_minimum_engaged_plays: 3,
            historical_return_minimum_listening_minutes: 10,
            relationship_minimum_years: 2,
            continuity_artist_limit: 10,
            release_minimum_distinct_tracks: 3,
            session_gap_minutes: 30,
            extended_sequence_minimum_plays: 5,
            listening_season_maximum_seasons: 80,
          },
        },
        curated_preferences: {
          saved_tracks: [
            {
              track_ref_id: "10000000-0000-4000-8000-000000000001",
              label: "Spotify Saved Track",
              artist_credit: "Spotify Artist",
              evidence_id: evidenceId,
            },
          ],
          playlist_anchors: [],
          followed_artists: [],
          saved_albums: [],
          avoids: [],
        },
        search_intent: [
          {
            query: "quoted search query",
            quoted_data: true,
            interactions: 1,
            result_entity_types: ["track"],
            last_searched_at: "2026-08-29T03:00:00.000Z",
            evidence_id: evidenceId,
          },
        ],
        provider_signals: {
          artists: [],
          tracks: [],
          genres: [],
          interpretations: [],
          highlights: [],
          metrics: [],
        },
        listening_source: {
          kind: "private_effective_listening_evidence",
          listening_range: {
            earliest: "2026-08-01T00:00:00.000Z",
            latest: "2026-08-29T04:00:00.000Z",
          },
          profile_captured_at: "2026-08-29T05:00:00.000Z",
        },
        ...(listenerAssertions
          ? { listener_assertions: listenerAssertions }
          : {}),
      };
    },
    close() {},
  };
  const application = new MoondogApplication({
    importsRoot: "/private/moondog-synthetic-missing-source",
    domainServices,
  });
  const { faux, runtime } = configuredRuntime(application);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_profile_summary", { max_items: 3 })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [profile] = toolResults(context, "moondog_profile_summary");
      assert.equal(profile.profile_version, "profile-projection/1");
      assert.equal(profile.coverage.listening_hours, 1.5);
      assert.equal(profile.listening_behavior.enduring_artists[0].name, "Spotify Artist");
      assert.equal(profile.curated_preferences.saved_tracks[0].label, "Spotify Saved Track");
      assert.deepEqual(profile.listener_assertions.active, []);
      assert.equal(profile.search_intent[0].quoted_data, true);
      assert.equal(profile.listening_behavior.context.start_reason_events, 10);
      assert.equal(profile.listening_behavior.context.trackdone_starts, 6);
      assert.equal(profile.listening_behavior.context.end_reason_events, 10);
      assert.equal(profile.listening_behavior.context.skip_state_events, 10);
      assert.equal(profile.listening_behavior.context.shuffle_state_events, 10);
      assert.equal(profile.listening_behavior.context.offline_state_events, 10);
      assert.equal(profile.listening_behavior.context.incognito_events_excluded, 1);
      assert.equal(
        profile.listening_behavior.rediscovery_tracks[0].label,
        "Quiet Coordinates",
      );
      assert.equal(
        profile.listening_behavior.rediscovery_tracks[0].quiet_days,
        241,
      );
      assert.equal(
        profile.listening_behavior.rediscovery_tracks[0].rediscovery_signal,
        "saved-library state",
      );
      assert.equal(
        profile.listening_behavior.historical_return_tracks[0].return_count,
        3,
      );
      assert.equal(profile.listening_behavior.history_arc[0].year, 2026);
      assert.equal(
        profile.listening_behavior.listening_seasons.projected_season_count,
        3,
      );
      assert.equal(
        profile.listening_behavior.listening_seasons.seasons[1].event_count,
        0,
      );
      assert.equal(
        profile.listening_behavior.listening_seasons.seasons[2].retained_month_count,
        2,
      );
      assert.equal(
        profile.listening_behavior.context.listening_season_maximum_seasons,
        80,
      );
      assert.doesNotMatch(
        JSON.stringify(profile.listening_behavior.listening_seasons),
        /10000000-0000-4000-8000-00000000000[45]/u,
      );
      assert.equal(
        profile.listening_behavior.artist_relationships[0].active_years,
        4,
      );
      assert.equal(
        profile.listening_behavior.year_transitions[0].continuity_percent,
        50,
      );
      assert.equal(
        profile.listening_behavior.release_depth[0].distinct_tracks,
        3,
      );
      assert.equal(
        profile.listening_behavior.session_summary.session_count,
        3,
      );
      return fauxAssistantMessage([fauxText("The private Spotify profile is available.")]);
    },
  ]);

  const result = await runtime.prompt("Use my Spotify listening profile.");
  assert.equal(result.text, "The private Spotify profile is available.");

  const correctionId = "40000000-0000-4000-8000-000000000001";
  const correction = {
    correction_id: correctionId,
    evidence_id: correctionId,
    entity_type: "artist",
    label: "Direct Listener Artist",
    stance: "like",
    strength: 1,
    asserted_at: "2026-09-03T02:00:00.000Z",
    note: "FREEFORM_NOTE_MUST_NOT_REACH_MODEL",
  };
  listenerAssertions = {
    active: [correction],
    preferences: [correction],
    avoids: [],
    retractions: 0,
  };
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_profile_summary", { max_items: 3 })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [profile] = toolResults(context, "moondog_profile_summary");
      assert.equal(
        profile.listener_assertions.preferences[0].label,
        "Direct Listener Artist",
      );
      assert.equal(
        "note" in profile.listener_assertions.preferences[0],
        false,
      );
      assert.doesNotMatch(
        JSON.stringify(profile),
        /FREEFORM_NOTE_MUST_NOT_REACH_MODEL/u,
      );
      return fauxAssistantMessage([
        fauxText("The direct listener assertion is available."),
      ]);
    },
  ]);
  const corrected = await runtime.prompt("Use my direct correction.");
  assert.equal(
    corrected.text,
    "The direct listener assertion is available.",
  );
  application.close();
});

test("a validated plan is authoritative and overlapping prompts fail before scope reset", async () => {
  const application = syntheticApplication();
  const { faux, runtime } = configuredRuntime(application);
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxText("Invented preview naming an untrusted track."),
        fauxToolCall("moondog_library_search", {
          query: "night",
          limit: 1,
        }),
      ],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_playlist_plan", {
            intent: "Plan 1 track.",
            requested_track_count: 1,
            candidate_set_ids: [search.candidate_set_id],
            track_refs: [
              {
                track_ref_id: search.tracks[0].track_ref_id,
                selection_reason: "Grounded in the current search result.",
              },
            ],
            ordering_notes: "One validated selection.",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage([
      fauxText("Invented final text naming an unrelated imaginary track."),
    ]),
  ]);

  let overlapPromise;
  let displayedText = "";
  const result = await runtime.prompt("Plan one night track.", {
    onTextDelta(delta) {
      displayedText += delta;
    },
    onTextReplace(replacement) {
      displayedText = replacement;
    },
    onToolEnd(tool) {
      if (tool.toolName === "moondog_library_search" && !overlapPromise) {
        overlapPromise = runtime.prompt("overlapping prompt").then(
          () => null,
          (error) => error,
        );
      }
    },
  });
  const overlapError = await overlapPromise;
  assert.match(overlapError.message, /already in progress/iu);

  assert.equal(result.status, "completed");
  assert.equal(result.playlist_plan.track_count, 1);
  assert.equal(result.text.includes("imaginary track"), false);
  assert.ok(result.text.includes(result.playlist_plan.tracks[0].title));
  assert.equal(displayedText, result.text);
  assert.equal(displayedText.includes("untrusted track"), false);
  assert.deepEqual(
    runtime.agent.state.messages.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.equal(
    JSON.stringify(runtime.agent.state.messages).includes("candidate_set_id"),
    false,
  );
});

test("an aborted prompt never renders or retains a previously validated plan", async () => {
  const application = syntheticApplication();
  const { faux, runtime } = configuredRuntime(application);
  let abortedCandidateSetId;
  let abortedTrackTitle;
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxText("Invented pre-plan track that must be cleared."),
        fauxToolCall("moondog_library_search", { query: "night", limit: 1 }),
      ],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      abortedCandidateSetId = search.candidate_set_id;
      abortedTrackTitle = search.tracks[0].title;
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_playlist_plan", {
            intent: "Plan 1 track.",
            requested_track_count: 1,
            candidate_set_ids: [search.candidate_set_id],
            track_refs: [
              {
                track_ref_id: search.tracks[0].track_ref_id,
                selection_reason: "Current prompt candidate.",
              },
            ],
            ordering_notes: "One track.",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const serialized = JSON.stringify(context.messages);
      assert.equal(serialized.includes(abortedCandidateSetId), false);
      assert.equal(serialized.includes(abortedTrackTitle), false);
      assert.equal(serialized.includes("Plan one track."), false);
      return fauxAssistantMessage([
        fauxText("A fresh response without an inherited track list."),
      ]);
    },
  ]);

  const result = await runtime.prompt("Plan one track.", {
    onToolEnd(tool) {
      if (tool.toolName === "moondog_playlist_plan" && !tool.isError) {
        runtime.abort();
      }
    },
  });

  assert.equal(result.status, "aborted");
  assert.equal("playlist_plan" in result, false);
  assert.equal(result.text, "");
  assert.deepEqual(runtime.agent.state.messages, []);
  assert.equal(application.pendingSpotifyPlaylistStatus().state, "none");

  const nextResult = await runtime.prompt("Answer without searching.");
  assert.equal(
    nextResult.text,
    "A fresh response without an inherited track list.",
  );
});

test("a plan that fails output redaction is never captured as authoritative", async () => {
  const application = syntheticApplication();
  application.buildPlaylistPlan = async ({ intent, trackRefs }) => ({
    plan_version: "playlist_plan/0",
    intent,
    requested_track_count: 1,
    track_count: 1,
    tracks: [
      {
        position: 1,
        track_ref_id: trackRefs[0].trackRefId,
        title: "/Users/private/should-not-surface.m4a",
        artist_credit: "Safe artist",
        release: "Safe release",
        selection_reason: trackRefs[0].selectionReason,
      },
    ],
    ordering_rationale: "One track.",
    candidate_sets_validated: 1,
    persistence: "none",
    external_effects: "none",
  });
  const { faux, runtime } = configuredRuntime(application);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_library_search", { query: "night", limit: 1 })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      return fauxAssistantMessage(
        [
          fauxToolCall("moondog_playlist_plan", {
            intent: "Plan 1 track.",
            requested_track_count: 1,
            candidate_set_ids: [search.candidate_set_id],
            track_refs: [
              {
                track_ref_id: search.tracks[0].track_ref_id,
                selection_reason: "Current prompt candidate.",
              },
            ],
            ordering_notes: "One track.",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage([
      fauxText("Pretend that the unsafe plan succeeded anyway."),
    ]),
  ]);

  const result = await runtime.prompt("Plan one track.");

  assert.equal(result.status, "completed");
  assert.equal("playlist_plan" in result, false);
  assert.match(result.text, /could not validate/iu);
  assert.equal(result.text.includes("/Users/private"), false);
  assert.equal(result.text.includes("Pretend"), false);
  assert.deepEqual(
    runtime.agent.state.messages.map((message) => message.role),
    ["user", "assistant"],
  );
  const retainedHistory = JSON.stringify(runtime.agent.state.messages);
  assert.equal(retainedHistory.includes("candidate_set_id"), false);
  assert.equal(retainedHistory.includes("/Users/private"), false);
  assert.equal(retainedHistory.includes("Pretend"), false);
});

test("model arguments cannot select a trusted subject", async () => {
  const application = syntheticApplication();
  let searchCalls = 0;
  const trustedSearch = application.searchLibrary.bind(application);
  application.searchLibrary = async (input) => {
    searchCalls += 1;
    return trustedSearch(input);
  };
  const { faux, runtime } = configuredRuntime(application);
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("moondog_library_search", {
          query: "night",
          subject_id: "model-controlled-subject",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("I cannot override the trusted subject.")]),
  ]);

  const ends = [];
  const result = await runtime.prompt("Search another subject.", {
    onToolEnd: (tool) => ends.push(tool),
  });

  assert.equal(result.text, "I cannot override the trusted subject.");
  assert.equal(searchCalls, 0);
  assert.equal(ends[0].isError, true);
});

test("runtime projects domain results before model content and details", async () => {
  const application = syntheticApplication();
  application.searchLibrary = async () => ({
    candidate_set_id: "30000000-0000-4000-8000-000000000001",
    result_count: 99,
    limit_applied: 1,
    offset_applied: 4,
    next_offset: 5,
    has_more: true,
    expires_on: "never",
    subject_id: "PRIVATE_SUBJECT_SENTINEL",
    tracks: [
      {
        track_ref_id: "10000000-0000-4000-8000-000000000001",
        title: "Safe title",
        artist_credit: "Safe artist",
        release: "Safe release",
        labels: { genres: ["Ambient"] },
        observation_summary: {
          preference_signals: ["loved"],
          familiarity: {
            level: "high",
            basis: "aggregate_play_count",
            play_count: 8,
          },
        },
        provider_id: "PRIVATE_PROVIDER_SENTINEL",
        source_path: "/Users/private/library/file.m4a",
        raw_observation: { private: true },
      },
    ],
  });
  const { faux, runtime } = configuredRuntime(application);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_library_search", { query: "safe" })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const serialized = JSON.stringify(context);
      assert.equal(serialized.includes("PRIVATE_SUBJECT_SENTINEL"), false);
      assert.equal(serialized.includes("PRIVATE_PROVIDER_SENTINEL"), false);
      assert.equal(serialized.includes("/Users/private"), false);
      const [search] = toolResults(context, "moondog_library_search");
      assert.equal(search.result_count, 1);
      assert.equal(search.offset_applied, 4);
      assert.equal(search.next_offset, 5);
      assert.equal(search.expires_on, "prompt_end");
      assert.deepEqual(Object.keys(search.tracks[0]).sort(), [
        "artist_credit",
        "labels",
        "observation_summary",
        "release",
        "title",
        "track_ref_id",
      ]);
      return fauxAssistantMessage([fauxText("The bounded result is safe.")]);
    },
  ]);

  const result = await runtime.prompt("Search safely.");
  assert.equal(result.text, "The bounded result is safe.");
});

test("oversized projected tool output fails at the byte ceiling without leakage", async () => {
  const application = syntheticApplication();
  const oversized = "界".repeat(512);
  application.searchLibrary = async () => ({
    candidate_set_id: "bounded-candidate-set",
    result_count: 12,
    limit_applied: 12,
    has_more: false,
    tracks: Array.from({ length: 12 }, (_, index) => ({
      track_ref_id: `track-${index + 1}`,
      title: oversized,
      artist_credit: oversized,
      release: oversized,
      labels: {
        genres: Array.from({ length: 4 }, () => "界".repeat(128)),
        composer: "界".repeat(256),
      },
      observation_summary: {
        preference_signals: ["loved", "favorited", "rated"],
        familiarity: {
          level: "high",
          basis: "aggregate_play_count",
          play_count: 10,
        },
      },
    })),
  });
  const { faux, runtime } = configuredRuntime(application);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_library_search", { query: "large" })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const resultMessage = context.messages.find(
        (message) => message.role === "toolResult",
      );
      assert.equal(resultMessage.isError, true);
      assert.match(resultMessage.content[0].text, /domain_result_too_large/iu);
      assert.equal(resultMessage.content[0].text.includes(oversized), false);
      assert.deepEqual(resultMessage.details, {});
      return fauxAssistantMessage([
        fauxText("The bounded search result was too large to return safely."),
      ]);
    },
  ]);

  const ends = [];
  const result = await runtime.prompt("Exercise the result byte limit.", {
    onToolEnd: (tool) => ends.push(tool),
  });

  assert.match(result.text, /too large to return safely/iu);
  assert.equal(ends[0].isError, true);
  assert.equal(JSON.stringify(runtime.agent.state.messages).includes(oversized), false);
});

test("empty search and a domain failure remain recoverable model turns", async () => {
  const application = syntheticApplication();
  const { faux, runtime } = configuredRuntime(application);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_library_search", { query: "no-such-track" })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      const [search] = toolResults(context, "moondog_library_search");
      assert.equal(search.result_count, 0);
      assert.deepEqual(search.tracks, []);
      return fauxAssistantMessage([
        fauxText("No matching library tracks were found. Try a broader intent."),
      ]);
    },
  ]);

  const result = await runtime.prompt("Find the missing track.");
  assert.match(result.text, /No matching library tracks/);

  const failingApplication = syntheticApplication();
  failingApplication.searchLibrary = async () => {
    throw new DomainServiceError(
      "projection_unavailable",
      "The local projection at /Users/private/profile.sqlite is unavailable.",
    );
  };
  const configured = configuredRuntime(failingApplication);
  configured.faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("moondog_library_search", { query: "night" })],
      { stopReason: "toolUse" },
    ),
    (context) => {
      assert.equal(JSON.stringify(context).includes("/Users/private"), false);
      return fauxAssistantMessage([
        fauxText(
          "The local library projection is unavailable, so I cannot list tracks.",
        ),
      ]);
    },
  ]);
  const failureEnds = [];
  const failureResult = await configured.runtime.prompt("Search my library.", {
    onToolEnd: (tool) => failureEnds.push(tool),
  });
  assert.match(failureResult.text, /projection is unavailable/);
  assert.equal(failureEnds[0].isError, true);
});
