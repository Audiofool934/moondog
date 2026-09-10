import { MoondogApplication } from "../core/moondog-application.mjs";
import { createSyntheticDomainServices } from "../core/synthetic-domain-services.mjs";
import { createConfiguredRuntime } from "../runtime/pi/configured-runtime.mjs";

export const MOONDOG_DEMO_PROMPT =
  "Build a six-track late-night drive playlist from the demo library. Start familiar, then add a measured amount of surprise. Inspect and explain at least one key profile evidence record before planning. Explain the ordering. Do not save or play anything.";

const demoSubjectId = "10000000-0000-4000-8000-000000000000";

const offlineSelection = Object.freeze([
  Object.freeze({
    title: "Midnight Lines",
    reason:
      "An explicit loved and rated signal plus high familiarity makes this a grounded opening anchor.",
  }),
  Object.freeze({
    title: "Glass Highway",
    reason:
      "A favorited track with high familiarity keeps the opening inside established evidence.",
  }),
  Object.freeze({
    title: "Blue Exit",
    reason:
      "Medium familiarity makes this a measured bridge away from the two strongest anchors.",
  }),
  Object.freeze({
    title: "Soft Static",
    reason:
      "Low familiarity introduces a bounded surprise without claiming that the track is new or preferred.",
  }),
  Object.freeze({
    title: "Empty Overpass",
    reason:
      "One observed play makes this the largest familiarity stretch in the sequence.",
  }),
  Object.freeze({
    title: "First Light Behind Us",
    reason:
      "Medium familiarity and a favorited artist return the close toward established evidence.",
  }),
]);

const offlineSteps = Object.freeze({
  profile: Object.freeze({
    tool: "moondog_profile_summary",
    capability: "profile.summary",
    label: "Read the synthetic music profile",
  }),
  evidence: Object.freeze({
    tool: "moondog_profile_explain",
    capability: "profile.explain",
    label: "Inspect one profile evidence record",
  }),
  search: Object.freeze({
    tool: "moondog_library_search",
    capability: "library.search",
    label: "Search the synthetic library",
  }),
  plan: Object.freeze({
    tool: "moondog_playlist_plan",
    capability: "playlist.plan",
    label: "Validate the playlist plan",
  }),
});

const demoNextSteps = Object.freeze([
  Object.freeze({
    id: "open_visual_tour",
    title: "Open the visual Listening Time Machine",
    checkout_command: "npm run demo:studio",
    installed_command: "moondog studio --demo",
    data_boundary:
      "The fictional tour stays on 127.0.0.1, reads no private history, rejects imports, and keeps corrections only in process memory.",
  }),
  Object.freeze({
    id: "open_session_studio",
    title: "Open your history without importing it",
    checkout_command:
      "npm --silent run demo:studio -- --from /absolute/path/to/spotify-history.zip",
    installed_command:
      "moondog studio --from /absolute/path/to/spotify-history.zip",
    data_boundary:
      "No dependency installation is required. The archive stays unchanged, the private profile and corrections live only in process memory, and no model, provider, cloud, or network request is made.",
  }),
  Object.freeze({
    id: "open_private_studio",
    title: "Bring your own listening history",
    checkout_command: "npm run studio",
    installed_command: "moondog studio",
    data_boundary:
      "Studio stays on 127.0.0.1. The fictional preview saves nothing. Import changes private local state only after an explicit button press.",
  }),
]);

function createDemoNextSteps() {
  return demoNextSteps.map((step) => ({ ...step }));
}

class DemoApplication extends MoondogApplication {
  async sourceStatus() {
    return {
      source: "synthetic_demo_library",
      state: "ready",
      valid_batches: 1,
      invalid_batches: 0,
      latest: {
        captured_at: "2026-08-25T00:00:00.000Z",
        tracks: 8,
        playlists: 0,
        playlist_item_references: 0,
        aggregate_track_snapshots: 8,
        listening_events: 0,
        taste_events: 0,
        loved_or_favorited_coverage: 4,
        aggregate_play_count_coverage: 7,
      },
      semantics: {
        library_snapshot_available: true,
        complete_listening_history_available: false,
        profile_materialization_ready: true,
      },
    };
  }

  async profileStatus() {
    return {
      state: "ready",
      projection_version: "profile_projection/0",
      evidence_records: 5,
      claims: 0,
      reason:
        "The public demo uses an explicitly synthetic, bounded music profile.",
    };
  }
}

function cleanDemoPrompt(value) {
  if (value === undefined) return MOONDOG_DEMO_PROMPT;
  if (typeof value !== "string") {
    throw new TypeError("The demo prompt must be text.");
  }
  const cleaned = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned || Array.from(cleaned).length > 1_000) {
    throw new TypeError("The demo prompt must contain 1 to 1000 characters.");
  }
  return cleaned;
}

function createDemoApplication() {
  return new DemoApplication({
    importsRoot: "/moondog/synthetic-demo/does-not-read-local-imports",
    domainServices: createSyntheticDomainServices({
      subjectScope: { subjectId: demoSubjectId },
    }),
  });
}

async function captureOfflineStep(trace, step, action) {
  const entry = {
    sequence: trace.length + 1,
    tool: step.tool,
    capability: step.capability,
    label: step.label,
    status: "running",
  };
  trace.push(entry);
  try {
    const result = await action();
    entry.status = "completed";
    return result;
  } catch (error) {
    entry.status = "failed";
    throw error;
  }
}

function offlineResultText(profile, evidence, plan) {
  const preference = profile.strong_preferences[0];
  return [
    `Profile anchor: ${preference.label} - ${preference.signal}.`,
    `Evidence checked: ${evidence.basis_summary}`,
    "",
    ...plan.tracks.map(
      (track) =>
        `${track.position}. ${track.title} - ${track.artist_credit}\n   ${track.selection_reason}`,
    ),
    "",
    `Ordering: ${plan.ordering_rationale}`,
    "Grounding boundary: play count supports familiarity, not liking; low familiarity does not prove novelty.",
    "Action boundary: the host validated track identity, candidate membership, count, and order without saving or playing anything.",
  ].join("\n");
}

async function runOfflineDemo(application, prompt) {
  const trace = [];
  application.beginPrompt();
  try {
    const profile = await captureOfflineStep(
      trace,
      offlineSteps.profile,
      () => application.getProfileSummary({ maxItems: 6 }),
    );
    const evidenceId = profile.strong_preferences[0]?.evidence_id;
    if (!evidenceId) {
      throw new Error("The synthetic demo profile has no explainable preference evidence.");
    }
    const evidence = await captureOfflineStep(
      trace,
      offlineSteps.evidence,
      () => application.explainProfileEvidence({ evidenceId }),
    );
    const search = await captureOfflineStep(
      trace,
      offlineSteps.search,
      () => application.searchLibrary({ query: "night drive", limit: 8 }),
    );
    const tracksByTitle = new Map(
      search.tracks.map((track) => [track.title, track]),
    );
    const selections = offlineSelection.map((selection) => {
      const track = tracksByTitle.get(selection.title);
      if (!track) {
        throw new Error(
          `The synthetic demo library is missing ${selection.title}.`,
        );
      }
      return {
        trackRefId: track.track_ref_id,
        selectionReason: selection.reason,
      };
    });
    const plan = await captureOfflineStep(
      trace,
      offlineSteps.plan,
      () =>
        application.buildPlaylistPlan({
          intent: prompt,
          requestedTrackCount: selections.length,
          candidateSetIds: [search.candidate_set_id],
          trackRefs: selections,
          orderingNotes:
            "Start with two explicit preference anchors, cross a medium-familiarity bridge, introduce two low-familiarity tracks, then close with a favorited artist.",
        }),
    );
    return {
      demo_version: "moondog-demo/3",
      mode: "synthetic_offline_read_only",
      prompt,
      runtime: {
        provider: "none",
        model: "deterministic-showcase/1",
      },
      coverage: {
        library_tracks: 8,
        profile_evidence: 5,
        external_effects: "disabled",
      },
      tool_trace: trace,
      result: {
        status: "completed",
        text: offlineResultText(profile, evidence, plan),
        playlist_plan: structuredClone(plan),
      },
      limitations: [
        "The library and profile are synthetic demonstration data.",
        "The offline walkthrough is deterministic and does not call a language model or music service.",
        "The demo cannot write playlists, control playback, or access private local music data.",
        "This walkthrough proves the grounded product path, not subjective curation quality.",
      ],
      next_steps: createDemoNextSteps(),
    };
  } finally {
    application.endPrompt();
  }
}

export async function runMoondogDemo({
  prompt,
  offline = false,
  runtimeBuilder = createConfiguredRuntime,
} = {}) {
  const demoPrompt = cleanDemoPrompt(prompt);
  const application = createDemoApplication();
  let runtime;
  try {
    if (offline) return await runOfflineDemo(application, demoPrompt);
    runtime = await runtimeBuilder(application);
    const runtimeStatus = runtime.publicStatus();
    if (runtimeStatus.state !== "configured") {
      const error = new Error(
        "The Moondog demo needs a configured model. Run moondog, then use /auth and /model before retrying moondog demo.",
      );
      error.code = runtimeStatus.reason ?? "model_not_configured";
      throw error;
    }

    const trace = [];
    const traceByCallId = new Map();
    const result = await runtime.prompt(demoPrompt, {
      onToolStart(event) {
        const entry = {
          sequence: trace.length + 1,
          tool: event.toolName,
          capability: event.capabilityId,
          label: event.label,
          status: "running",
        };
        trace.push(entry);
        traceByCallId.set(event.toolCallId, entry);
      },
      onToolEnd(event) {
        const entry = traceByCallId.get(event.toolCallId);
        if (!entry) return;
        entry.status = event.isError ? "failed" : "completed";
      },
    });

    return {
      demo_version: "moondog-demo/2",
      mode: "synthetic_read_only",
      prompt: demoPrompt,
      runtime: {
        provider: runtimeStatus.provider,
        model: runtimeStatus.model,
      },
      coverage: {
        library_tracks: 8,
        profile_evidence: 5,
        external_effects: "disabled",
      },
      tool_trace: trace,
      result: {
        status: result.status,
        text: result.text,
        ...(result.playlist_plan
          ? { playlist_plan: structuredClone(result.playlist_plan) }
          : {}),
      },
      limitations: [
        "The library and profile are synthetic demonstration data.",
        "The demo calls the configured model provider but no music service.",
        "The demo cannot write playlists, control playback, or access private local music data.",
        "One model response is a product walkthrough, not a curation benchmark.",
      ],
      next_steps: createDemoNextSteps(),
    };
  } finally {
    runtime?.abort?.();
    application.close();
  }
}
