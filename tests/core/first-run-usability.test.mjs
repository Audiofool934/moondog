import assert from "node:assert/strict";
import test from "node:test";

import {
  computeFirstRunUsabilityProtocolDigest,
  createFirstRunUsabilityProtocol,
  createPublicFirstRunUsabilitySummary,
  summarizeFirstRunUsabilitySummary,
  validateFirstRunUsabilityProtocol,
  validateFirstRunUsabilitySession,
} from "../../src/evaluation/first-run-usability.mjs";

function completedSession(
  protocol,
  participantId,
  {
    platform = "macos",
    blockedTask = null,
    hesitationCategory = "navigation",
    assumptions = [],
  } = {},
) {
  const tasks = protocol.tasks.map((task, index) => {
    const blockedIndex = blockedTask
      ? protocol.tasks.findIndex((candidate) => candidate.id === blockedTask)
      : -1;
    const outcome =
      blockedIndex === -1
        ? "completed"
        : index < blockedIndex
          ? "completed"
          : index === blockedIndex
            ? "blocked"
            : "skipped";
    return {
      task_id: task.id,
      outcome,
      elapsed_seconds: outcome === "skipped" ? null : 30 + index * 10,
      assistance: outcome === "blocked" ? "hint" : "none",
      note:
        outcome === "blocked"
          ? `PRIVATE ${participantId} stopped at ${task.id}.`
          : "",
    };
  });
  const firstCompleted = tasks.find((task) => task.outcome === "completed");
  return {
    session_version: "first-run-usability-session/1",
    protocol_id: protocol.protocol_id,
    protocol_sha256: protocol.protocol_sha256,
    completed_at: "2026-09-03T10:00:00.000Z",
    privacy: {
      classification: "private_local_usability_session",
      no_personal_music_data: true,
      consent_to_aggregate: true,
    },
    participant: {
      participant_id: participantId,
      independent: true,
      built_moondog_before: false,
    },
    environment: {
      platform,
      installation_source: "clean_source_checkout",
      node_major: 24,
      session_mode: "in_person",
    },
    tasks,
    observations: {
      first_hesitation: {
        status: "observed",
        task_id: blockedTask ?? "offline_demo",
        category: hesitationCategory,
        note: `PRIVATE hesitation from ${participantId}.`,
      },
      first_success: firstCompleted
        ? {
            status: "observed",
            task_id: firstCompleted.task_id,
            elapsed_seconds: firstCompleted.elapsed_seconds,
          }
        : { status: "none", task_id: null, elapsed_seconds: null },
      misleading_assumptions: assumptions.length
        ? {
            observed: true,
            categories: assumptions,
            first_task_id: blockedTask ?? "offline_demo",
            note: `PRIVATE assumption from ${participantId}.`,
          }
        : {
            observed: false,
            categories: [],
            first_task_id: null,
            note: "",
          },
      stopping_point: blockedTask
        ? {
            task_id: blockedTask,
            reason: "blocked",
            note: `PRIVATE stop from ${participantId}.`,
          }
        : { task_id: "completed_all", reason: "completed_all", note: "" },
    },
  };
}

test("first-run protocol is deterministic for one timestamp and validates", () => {
  const first = createFirstRunUsabilityProtocol({
    generatedAt: "2026-09-03T08:00:00.000Z",
  });
  const second = createFirstRunUsabilityProtocol({
    generatedAt: "2026-09-03T08:00:00.000Z",
  });

  assert.deepEqual(first, second);
  assert.match(first.protocol_id, /^fru-[a-f0-9]{16}$/u);
  assert.equal(first.protocol_version, "first-run-usability-protocol/3");
  assert.equal(first.tasks.length, 8);
  assert.equal(first.privacy.uses_personal_music_data, false);
  assert.equal(first.privacy.uses_generated_fictional_history, true);
  assert.equal(first.tasks[0].id, "start_studio");
  assert.match(first.tasks[0].instruction, /before installing dependencies/u);
  assert.equal(first.tasks[5].id, "clean_install");
  assert.equal(first.tasks[7].id, "generate_history");
  assert.deepEqual(validateFirstRunUsabilityProtocol(first), {
    protocol_id: first.protocol_id,
    task_count: 8,
    protocol_sha256: first.protocol_sha256,
  });
});

test("the current validator preserves completed version-two protocol artifacts", () => {
  const protocol = createFirstRunUsabilityProtocol({
    generatedAt: "2026-09-03T08:00:00.000Z",
  });
  const versionTwoOrder = [
    "clean_install",
    "offline_demo",
    "generate_history",
    "start_studio",
    "fictional_profile",
    "recap_card",
    "correction_loop",
    "portable_card",
  ];
  protocol.protocol_version = "first-run-usability-protocol/2";
  protocol.tasks = versionTwoOrder.map((taskId, index) => ({
    ...protocol.tasks.find((task) => task.id === taskId),
    position: index + 1,
  }));
  protocol.protocol_sha256 = computeFirstRunUsabilityProtocolDigest(protocol);

  assert.deepEqual(validateFirstRunUsabilityProtocol(protocol), {
    protocol_id: protocol.protocol_id,
    task_count: 8,
    protocol_sha256: protocol.protocol_sha256,
  });
});

test("the current validator preserves completed version-one protocol artifacts", () => {
  const protocol = createFirstRunUsabilityProtocol({
    generatedAt: "2026-09-03T08:00:00.000Z",
  });
  protocol.protocol_version = "first-run-usability-protocol/1";
  const versionOneOrder = [
    "clean_install",
    "offline_demo",
    "start_studio",
    "fictional_profile",
    "recap_card",
    "correction_loop",
    "portable_card",
  ];
  protocol.tasks = versionOneOrder.map((taskId, index) => ({
    ...protocol.tasks.find((task) => task.id === taskId),
    position: index + 1,
  }));
  delete protocol.privacy.uses_generated_fictional_history;
  protocol.protocol_sha256 = computeFirstRunUsabilityProtocolDigest(protocol);

  assert.deepEqual(validateFirstRunUsabilityProtocol(protocol), {
    protocol_id: protocol.protocol_id,
    task_count: 7,
    protocol_sha256: protocol.protocol_sha256,
  });
});

test("completed newcomer session validates exact task and observation relationships", () => {
  const protocol = createFirstRunUsabilityProtocol({
    generatedAt: "2026-09-03T08:00:00.000Z",
  });
  const session = completedSession(protocol, "newcomer-alpha");

  assert.deepEqual(validateFirstRunUsabilitySession(session, protocol), {
    protocol_id: protocol.protocol_id,
    participant_id: "newcomer-alpha",
    completed_tasks: 8,
    blocked_tasks: 0,
    skipped_tasks: 0,
  });
});

test("session validation rejects builders, personal-data collection, and false success order", () => {
  const protocol = createFirstRunUsabilityProtocol({
    generatedAt: "2026-09-03T08:00:00.000Z",
  });
  const builder = completedSession(protocol, "builder");
  builder.participant.built_moondog_before = true;
  assert.throws(
    () => validateFirstRunUsabilitySession(builder, protocol),
    /independent newcomer/u,
  );

  const personalData = completedSession(protocol, "private-data");
  personalData.privacy.no_personal_music_data = false;
  assert.throws(
    () => validateFirstRunUsabilitySession(personalData, protocol),
    /no personal music data/u,
  );

  const wrongSuccess = completedSession(protocol, "wrong-success");
  wrongSuccess.observations.first_success.task_id = "recap_card";
  assert.throws(
    () => validateFirstRunUsabilitySession(wrongSuccess, protocol),
    /first completed task/u,
  );
});

test("aggregate summary opens the three-newcomer gate without leaking private records", () => {
  const protocol = createFirstRunUsabilityProtocol({
    generatedAt: "2026-09-03T08:00:00.000Z",
  });
  const sessions = [
    completedSession(protocol, "newcomer-alpha", {
      blockedTask: "start_studio",
      assumptions: ["thought_data_was_uploaded"],
    }),
    completedSession(protocol, "newcomer-beta", {
      blockedTask: "start_studio",
      assumptions: ["thought_provider_action_occurred"],
    }),
    completedSession(protocol, "newcomer-gamma", { platform: "linux" }),
  ];

  const report = createPublicFirstRunUsabilitySummary({
    protocol,
    sessions,
    generatedAt: "2026-09-03T12:00:00.000Z",
  });
  const serialized = JSON.stringify(report);
  const summary = summarizeFirstRunUsabilitySummary(report);

  assert.equal(report.sample.independent_newcomer_sessions, 3);
  assert.equal(report.sample.platforms.macos, 2);
  assert.equal(report.sample.platforms.linux, 1);
  assert.equal(report.evidence_gate.ready, true);
  assert.deepEqual(report.evidence_gate.gaps, []);
  assert.equal(report.outcomes.first_hesitation_tasks.start_studio, 2);
  assert.equal(report.outcomes.first_success_tasks.start_studio, 1);
  assert.equal(report.outcomes.median_seconds_to_first_success, 30);
  assert.equal(
    report.outcomes.misleading_assumption_first_tasks.start_studio,
    2,
  );
  assert.equal(report.outcomes.stopping_points.start_studio, 2);
  assert.deepEqual(report.outcomes.repeated_failures, [
    {
      task_id: "start_studio",
      title: "Reach the interactive product without installing dependencies",
      blocked_sessions: 2,
    },
  ]);
  assert.equal(
    report.outcomes.misleading_assumption_categories
      .thought_data_was_uploaded,
    1,
  );
  assert.doesNotMatch(
    serialized,
    /newcomer-alpha|newcomer-beta|newcomer-gamma|PRIVATE|2026-09-03T10:00/u,
  );
  assert.match(summary, /Evidence gate: READY/u);
  assert.match(summary, /Median seconds to first success: 30/u);
  assert.match(
    summary,
    /Reach the interactive product without installing dependencies \(2\)/u,
  );
});

test("aggregate summary rejects repeated participant IDs", () => {
  const protocol = createFirstRunUsabilityProtocol({
    generatedAt: "2026-09-03T08:00:00.000Z",
  });
  assert.throws(
    () =>
      createPublicFirstRunUsabilitySummary({
        protocol,
        sessions: [
          completedSession(protocol, "newcomer-alpha"),
          completedSession(protocol, "newcomer-alpha"),
        ],
      }),
    /unique opaque participant ID/u,
  );
});
