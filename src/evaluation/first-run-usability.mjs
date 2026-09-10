import { createHash } from "node:crypto";

const MAXIMUM_NOTE_LENGTH = 2000;
const MAXIMUM_TASK_SECONDS = 4 * 60 * 60;

const taskDefinitions = Object.freeze({
  start_studio: Object.freeze({
    id: "start_studio",
    title: "Reach the interactive product without installing dependencies",
    instruction:
      "From the supplied clean source checkout, run the documented zero-data Studio command before installing dependencies, then open the loopback URL printed in the terminal.",
    success_criterion:
      "The participant reaches the local first screen without a node_modules directory and recognizes that the tour is fictional, runs on this computer, and does not accept listening files.",
  }),
  fictional_profile: Object.freeze({
    id: "fictional_profile",
    title: "Find the fictional Listening Time Machine",
    instruction:
      "Use the first-screen action to bring the already prepared fictional Listening Time Machine into view, then find the aggregate listening-pattern summary.",
    success_criterion:
      "The participant reaches the chronological year landmarks, 15 approximate listening stretches, and two multi-track releases without believing they contain personal listening history.",
  }),
  recap_card: Object.freeze({
    id: "recap_card",
    title: "Follow the route and inspect the recap",
    instruction:
      "Open the full fictional Listening Time Machine, then inspect the compact recap card and use its visible labels to explain what should be reviewed before sharing.",
    success_criterion:
      "The participant reaches the Time Machine evidence, opens the recap card, and identifies both its synthetic status and its review-before-sharing boundary.",
  }),
  correction_loop: Object.freeze({
    id: "correction_loop",
    title: "Correct and retract a reading",
    instruction:
      "Add one direct artist correction, observe its effect on the refreshed fictional profile, then retract it.",
    success_criterion:
      "The participant completes both actions and understands that the correction did not rewrite listening history.",
  }),
  portable_card: Object.freeze({
    id: "portable_card",
    title: "Download the portable recap",
    instruction:
      "Download the fictional recap as HTML and reopen the downloaded file outside the active Studio page.",
    success_criterion:
      "The participant opens the downloaded self-contained card and recognizes that downloading did not publish it.",
  }),
  clean_install: Object.freeze({
    id: "clean_install",
    title: "Install the complete CLI after first value",
    instruction:
      "After completing the zero-install Studio path, follow only the public setup instructions and complete the locked install from the supplied clean source checkout or package tarball.",
    success_criterion:
      "The install exits successfully without access to the maintainer's existing checkout, configuration, credentials, or local state.",
  }),
  offline_demo: Object.freeze({
    id: "offline_demo",
    title: "Run the zero-auth demo",
    instruction:
      "Run the documented offline demo and use its output to identify what Moondog can do before personal data or a provider connection is added.",
    success_criterion:
      "The participant reaches the six-track result and can identify that the walkthrough used fictional data and performed no provider write.",
  }),
  generate_history: Object.freeze({
    id: "generate_history",
    title: "Exercise the real importer with fictional history",
    instruction:
      "Find the documented fictional-history command, create the ZIP at a fresh absolute path, then pass that same file to the documented one-off Taste command.",
    success_criterion:
      "The participant reaches 52 effective events and the 2023 through 2026 Time Machine, and can identify that the archive is fictional and the one-off preview wrote no persistent profile state.",
  }),
});

const legacyTaskIds = Object.freeze([
  "clean_install",
  "offline_demo",
  "start_studio",
  "fictional_profile",
  "recap_card",
  "correction_loop",
  "portable_card",
]);

const versionTwoTaskIds = Object.freeze([
  "clean_install",
  "offline_demo",
  "generate_history",
  "start_studio",
  "fictional_profile",
  "recap_card",
  "correction_loop",
  "portable_card",
]);

const versionThreeTaskIds = Object.freeze([
  "start_studio",
  "fictional_profile",
  "recap_card",
  "correction_loop",
  "portable_card",
  "clean_install",
  "offline_demo",
  "generate_history",
]);

export const FIRST_RUN_USABILITY_TASKS = Object.freeze(
  versionThreeTaskIds.map((taskId) => taskDefinitions[taskId]),
);

export const FIRST_RUN_USABILITY_PROTOCOL_VERSIONS = Object.freeze([
  "first-run-usability-protocol/1",
  "first-run-usability-protocol/2",
  "first-run-usability-protocol/3",
]);

export const FIRST_RUN_HESITATION_CATEGORIES = Object.freeze([
  "navigation",
  "terminology",
  "command_or_setup",
  "waiting_or_feedback",
  "privacy_boundary",
  "capability_boundary",
  "error_recovery",
  "other",
]);

export const FIRST_RUN_ASSUMPTION_CATEGORIES = Object.freeze([
  "thought_real_data_was_required",
  "thought_data_was_uploaded",
  "thought_provider_action_occurred",
  "thought_output_was_safe_to_publish",
  "thought_correction_rewrote_history",
  "thought_fictional_data_was_personal",
  "thought_feature_was_available",
  "other",
]);

export const FIRST_RUN_USABILITY_CLAIM_THRESHOLDS = Object.freeze({
  minimum_independent_newcomer_sessions: 3,
});

const TASK_OUTCOMES = new Set(["completed", "blocked", "skipped"]);
const ASSISTANCE_LEVELS = new Set(["none", "hint", "takeover"]);
const PLATFORMS = new Set(["macos", "linux"]);
const INSTALLATION_SOURCES = new Set([
  "clean_source_checkout",
  "package_tarball",
]);
const SESSION_MODES = new Set([
  "in_person",
  "remote_screen_share",
  "unmoderated",
]);
const OBSERVATION_STATUSES = new Set(["observed", "none"]);
const STOPPING_REASONS = new Set([
  "completed_all",
  "blocked",
  "participant_choice",
  "time_limit",
  "technical_environment",
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function assertNonEmptyString(value, label, maximum = MAXIMUM_NOTE_LENGTH) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  if (value.length > maximum) {
    throw new RangeError(`${label} must be at most ${maximum} characters.`);
  }
  return value;
}

function assertOptionalString(value, label, maximum = MAXIMUM_NOTE_LENGTH) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }
  if (value.length > maximum) {
    throw new RangeError(`${label} must be at most ${maximum} characters.`);
  }
  return value;
}

function assertEnum(value, allowed, label) {
  if (!allowed.has(value)) {
    throw new TypeError(`${label} is not a supported value.`);
  }
  return value;
}

function assertIsoTimestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO timestamp.`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function protocolDigestInput(protocol) {
  return {
    protocol_version: protocol.protocol_version,
    protocol_id: protocol.protocol_id,
    created_at: protocol.created_at,
    privacy: protocol.privacy,
    eligibility: protocol.eligibility,
    methodology: protocol.methodology,
    environment_options: protocol.environment_options,
    tasks: protocol.tasks,
  };
}

export function computeFirstRunUsabilityProtocolDigest(protocol) {
  return sha256(JSON.stringify(protocolDigestInput(protocol)));
}

export function createFirstRunUsabilityProtocol({
  generatedAt = new Date().toISOString(),
} = {}) {
  assertIsoTimestamp(generatedAt, "generatedAt");
  const base = {
    protocol_version: "first-run-usability-protocol/3",
    created_at: generatedAt,
    privacy: {
      classification: "private_local_usability_protocol",
      uses_personal_music_data: false,
      uses_generated_fictional_history: true,
      session_boundary:
        "Use only the bundled fictional experience and the archive created by Moondog's fictional-history generator. Do not import a participant's listening archive, sign in to a provider, or enter credentials.",
      publication_boundary:
        "Keep completed session JSON private. Publish only the aggregate summary produced by this workflow.",
    },
    eligibility: {
      must_not_have_built_moondog: true,
      must_be_independent_of_implementation: true,
      participant_id:
        "Use a new opaque label containing no name, email address, username, or other direct identifier.",
    },
    methodology: {
      session_goal:
        "Observe whether a newcomer can reach Moondog's first useful local outcome and understand its privacy and capability boundaries.",
      observer_rules: [
        "Give the participant the clean copy and public README, but do not teach the task sequence before the session.",
        "Let the participant speak aloud and work unaided until the first hesitation or stop is recorded.",
        "Record a hint or takeover before helping, then let the participant continue.",
        "Record the first successful product outcome, even if it occurs after assistance.",
        "Record every misleading privacy or capability assumption in the bounded categories and keep free text private.",
        "Use only built-in or Moondog-generated fictional data and perform no provider login, provider write, or publication.",
      ],
      task_outcomes: {
        completed: "The success criterion was visibly met.",
        blocked: "The participant could not proceed without intervention.",
        skipped: "The task was not attempted, with the reason kept in the private note.",
      },
      assistance_levels: {
        none: "No facilitator help was given.",
        hint: "The facilitator gave a verbal or written hint.",
        takeover: "The facilitator performed part of the task.",
      },
    },
    environment_options: {
      platforms: [...PLATFORMS],
      installation_sources: [...INSTALLATION_SOURCES],
      session_modes: [...SESSION_MODES],
    },
    tasks: FIRST_RUN_USABILITY_TASKS.map((task, index) => ({
      position: index + 1,
      id: task.id,
      title: task.title,
      instruction: task.instruction,
      success_criterion: task.success_criterion,
    })),
  };
  const protocolId = `fru-${sha256(JSON.stringify(base)).slice(0, 16)}`;
  const protocol = {
    ...base,
    protocol_id: protocolId,
    protocol_sha256: null,
  };
  protocol.protocol_sha256 = computeFirstRunUsabilityProtocolDigest(protocol);
  return protocol;
}

function protocolTaskIds(version) {
  if (version === "first-run-usability-protocol/1") return legacyTaskIds;
  if (version === "first-run-usability-protocol/2") return versionTwoTaskIds;
  if (version === "first-run-usability-protocol/3") return versionThreeTaskIds;
  throw new TypeError("Unsupported first-run usability protocol version.");
}

function validateProtocolTasks(tasks, version) {
  const expectedIds = protocolTaskIds(version);
  if (!Array.isArray(tasks) || tasks.length !== expectedIds.length) {
    throw new TypeError("Protocol tasks do not match the supported first-run path.");
  }
  const observedIds = tasks.map((task) => task?.id);
  if (JSON.stringify(observedIds) !== JSON.stringify(expectedIds)) {
    throw new TypeError("Protocol tasks do not match the supported first-run path.");
  }
  for (const [index, task] of tasks.entries()) {
    assertPlainObject(task, `tasks[${index}]`);
    if (task.position !== index + 1) {
      throw new TypeError(`tasks[${index}].position is invalid.`);
    }
    assertNonEmptyString(task.title, `tasks[${index}].title`, 160);
    assertNonEmptyString(task.instruction, `tasks[${index}].instruction`);
    assertNonEmptyString(
      task.success_criterion,
      `tasks[${index}].success_criterion`,
    );
  }
}

export function validateFirstRunUsabilityProtocol(protocol) {
  assertPlainObject(protocol, "protocol");
  if (!FIRST_RUN_USABILITY_PROTOCOL_VERSIONS.includes(protocol.protocol_version)) {
    throw new TypeError("Unsupported first-run usability protocol version.");
  }
  if (!/^fru-[a-f0-9]{16}$/u.test(protocol.protocol_id)) {
    throw new TypeError("protocol_id must use the generated fru- plus 16-hex format.");
  }
  assertIsoTimestamp(protocol.created_at, "protocol.created_at");
  if (protocol.privacy?.classification !== "private_local_usability_protocol") {
    throw new TypeError("Protocol privacy classification is invalid.");
  }
  if (protocol.privacy?.uses_personal_music_data !== false) {
    throw new TypeError("The first-run protocol must prohibit personal music data.");
  }
  if (
    protocol.protocol_version !== "first-run-usability-protocol/1" &&
    protocol.privacy?.uses_generated_fictional_history !== true
  ) {
    throw new TypeError(
      "The current first-run protocol must require generated fictional history.",
    );
  }
  if (
    protocol.eligibility?.must_not_have_built_moondog !== true ||
    protocol.eligibility?.must_be_independent_of_implementation !== true
  ) {
    throw new TypeError("Protocol newcomer eligibility is invalid.");
  }
  validateProtocolTasks(protocol.tasks, protocol.protocol_version);
  const expectedDigest = computeFirstRunUsabilityProtocolDigest(protocol);
  if (protocol.protocol_sha256 !== expectedDigest) {
    throw new TypeError("Protocol digest does not match its content.");
  }
  return {
    protocol_id: protocol.protocol_id,
    task_count: protocol.tasks.length,
    protocol_sha256: protocol.protocol_sha256,
  };
}

function taskMap(protocol) {
  return new Map(protocol.tasks.map((task) => [task.id, task]));
}

function validateSessionTasks(sessionTasks, protocol) {
  if (!Array.isArray(sessionTasks) || sessionTasks.length !== protocol.tasks.length) {
    throw new TypeError("Session tasks must include every protocol task exactly once.");
  }
  const expectedIds = protocol.tasks.map((task) => task.id);
  const observedIds = sessionTasks.map((task) => task?.task_id);
  if (JSON.stringify(observedIds) !== JSON.stringify(expectedIds)) {
    throw new TypeError("Session tasks must preserve the protocol task order.");
  }
  for (const [index, task] of sessionTasks.entries()) {
    assertPlainObject(task, `session.tasks[${index}]`);
    assertEnum(task.outcome, TASK_OUTCOMES, `session.tasks[${index}].outcome`);
    assertEnum(
      task.assistance,
      ASSISTANCE_LEVELS,
      `session.tasks[${index}].assistance`,
    );
    assertOptionalString(task.note, `session.tasks[${index}].note`);
    if (task.outcome === "skipped") {
      if (task.elapsed_seconds !== null) {
        throw new TypeError(
          `session.tasks[${index}].elapsed_seconds must be null when skipped.`,
        );
      }
      continue;
    }
    if (
      !Number.isInteger(task.elapsed_seconds) ||
      task.elapsed_seconds < 0 ||
      task.elapsed_seconds > MAXIMUM_TASK_SECONDS
    ) {
      throw new RangeError(
        `session.tasks[${index}].elapsed_seconds must be an integer from 0 to ${MAXIMUM_TASK_SECONDS}.`,
      );
    }
  }
}

function validateFirstHesitation(observation, tasks) {
  assertPlainObject(observation, "observations.first_hesitation");
  assertEnum(
    observation.status,
    OBSERVATION_STATUSES,
    "observations.first_hesitation.status",
  );
  assertOptionalString(
    observation.note,
    "observations.first_hesitation.note",
  );
  if (observation.status === "none") {
    if (observation.task_id !== null || observation.category !== null) {
      throw new TypeError(
        "A first_hesitation status of none requires null task_id and category.",
      );
    }
    return;
  }
  if (!tasks.has(observation.task_id)) {
    throw new TypeError("observations.first_hesitation.task_id is invalid.");
  }
  assertEnum(
    observation.category,
    new Set(FIRST_RUN_HESITATION_CATEGORIES),
    "observations.first_hesitation.category",
  );
}

function validateFirstSuccess(observation, sessionTasks, tasks) {
  assertPlainObject(observation, "observations.first_success");
  assertEnum(
    observation.status,
    OBSERVATION_STATUSES,
    "observations.first_success.status",
  );
  const firstCompleted = sessionTasks.find((task) => task.outcome === "completed");
  if (observation.status === "none") {
    if (
      observation.task_id !== null ||
      observation.elapsed_seconds !== null
    ) {
      throw new TypeError(
        "A first_success status of none requires null task_id and elapsed_seconds.",
      );
    }
    if (firstCompleted) {
      throw new TypeError(
        "observations.first_success must identify the first completed task.",
      );
    }
    return;
  }
  if (!tasks.has(observation.task_id)) {
    throw new TypeError("observations.first_success.task_id is invalid.");
  }
  if (!firstCompleted || firstCompleted.task_id !== observation.task_id) {
    throw new TypeError(
      "observations.first_success must identify the first completed task.",
    );
  }
  if (
    !Number.isInteger(observation.elapsed_seconds) ||
    observation.elapsed_seconds < 0 ||
    observation.elapsed_seconds > MAXIMUM_TASK_SECONDS
  ) {
    throw new RangeError(
      `observations.first_success.elapsed_seconds must be an integer from 0 to ${MAXIMUM_TASK_SECONDS}.`,
    );
  }
}

function validateMisleadingAssumptions(observation, tasks) {
  assertPlainObject(observation, "observations.misleading_assumptions");
  if (typeof observation.observed !== "boolean") {
    throw new TypeError(
      "observations.misleading_assumptions.observed must be true or false.",
    );
  }
  if (!Array.isArray(observation.categories)) {
    throw new TypeError(
      "observations.misleading_assumptions.categories must be an array.",
    );
  }
  const categories = observation.categories;
  if (new Set(categories).size !== categories.length) {
    throw new TypeError(
      "observations.misleading_assumptions.categories must be unique.",
    );
  }
  for (const category of categories) {
    assertEnum(
      category,
      new Set(FIRST_RUN_ASSUMPTION_CATEGORIES),
      "observations.misleading_assumptions category",
    );
  }
  assertOptionalString(
    observation.note,
    "observations.misleading_assumptions.note",
  );
  if (observation.observed) {
    if (categories.length === 0 || !tasks.has(observation.first_task_id)) {
      throw new TypeError(
        "Observed misleading assumptions require categories and a valid first_task_id.",
      );
    }
  } else if (
    categories.length !== 0 ||
    observation.first_task_id !== null
  ) {
    throw new TypeError(
      "No misleading assumptions requires empty categories and a null first_task_id.",
    );
  }
}

function validateStoppingPoint(observation, sessionTasks, tasks) {
  assertPlainObject(observation, "observations.stopping_point");
  assertEnum(
    observation.reason,
    STOPPING_REASONS,
    "observations.stopping_point.reason",
  );
  assertOptionalString(observation.note, "observations.stopping_point.note");
  const allCompleted = sessionTasks.every((task) => task.outcome === "completed");
  if (allCompleted) {
    if (
      observation.task_id !== "completed_all" ||
      observation.reason !== "completed_all"
    ) {
      throw new TypeError(
        "A fully completed session requires the completed_all stopping point.",
      );
    }
    return;
  }
  if (!tasks.has(observation.task_id) || observation.reason === "completed_all") {
    throw new TypeError(
      "An incomplete session requires a protocol task and non-completion stopping reason.",
    );
  }
  const firstIncomplete = sessionTasks.find((task) => task.outcome !== "completed");
  if (firstIncomplete?.task_id !== observation.task_id) {
    throw new TypeError(
      "The stopping point must identify the first task that was not completed.",
    );
  }
}

export function validateFirstRunUsabilitySession(session, protocol) {
  const protocolResult = validateFirstRunUsabilityProtocol(protocol);
  assertPlainObject(session, "session");
  if (session.session_version !== "first-run-usability-session/1") {
    throw new TypeError("Unsupported first-run usability session version.");
  }
  if (
    session.protocol_id !== protocolResult.protocol_id ||
    session.protocol_sha256 !== protocolResult.protocol_sha256
  ) {
    throw new TypeError("Session protocol identity or digest does not match.");
  }
  assertIsoTimestamp(session.completed_at, "session.completed_at");
  if (session.privacy?.classification !== "private_local_usability_session") {
    throw new TypeError("Session privacy classification is invalid.");
  }
  if (
    session.privacy?.no_personal_music_data !== true ||
    session.privacy?.consent_to_aggregate !== true
  ) {
    throw new TypeError(
      "Session must confirm no personal music data and aggregate consent.",
    );
  }
  const participant = assertPlainObject(session.participant, "participant");
  const participantId = assertNonEmptyString(
    participant.participant_id,
    "participant.participant_id",
    64,
  );
  if (!/^[A-Za-z0-9._-]+$/u.test(participantId)) {
    throw new TypeError(
      "participant.participant_id must use only letters, numbers, dots, underscores, or hyphens.",
    );
  }
  if (
    participant.independent !== true ||
    participant.built_moondog_before !== false
  ) {
    throw new TypeError(
      "The participant must be an independent newcomer who did not build Moondog.",
    );
  }
  const environment = assertPlainObject(session.environment, "environment");
  assertEnum(environment.platform, PLATFORMS, "environment.platform");
  assertEnum(
    environment.installation_source,
    INSTALLATION_SOURCES,
    "environment.installation_source",
  );
  assertEnum(environment.session_mode, SESSION_MODES, "environment.session_mode");
  if (!Number.isInteger(environment.node_major) || environment.node_major < 22) {
    throw new TypeError("environment.node_major must be an integer of at least 22.");
  }
  validateSessionTasks(session.tasks, protocol);
  const tasks = taskMap(protocol);
  const observations = assertPlainObject(session.observations, "observations");
  validateFirstHesitation(observations.first_hesitation, tasks);
  validateFirstSuccess(observations.first_success, session.tasks, tasks);
  validateMisleadingAssumptions(observations.misleading_assumptions, tasks);
  validateStoppingPoint(observations.stopping_point, session.tasks, tasks);
  return {
    protocol_id: protocol.protocol_id,
    participant_id: participantId,
    completed_tasks: session.tasks.filter((task) => task.outcome === "completed")
      .length,
    blocked_tasks: session.tasks.filter((task) => task.outcome === "blocked")
      .length,
    skipped_tasks: session.tasks.filter((task) => task.outcome === "skipped")
      .length,
  };
}

function increment(object, key, amount = 1) {
  object[key] = (object[key] ?? 0) + amount;
}

function rate(numerator, denominator) {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10000) / 100;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function createPublicFirstRunUsabilitySummary({
  protocol,
  sessions,
  generatedAt = new Date().toISOString(),
}) {
  validateFirstRunUsabilityProtocol(protocol);
  assertIsoTimestamp(generatedAt, "generatedAt");
  if (!Array.isArray(sessions) || sessions.length === 0) {
    throw new TypeError("At least one completed usability session is required.");
  }
  const validations = sessions.map((session) =>
    validateFirstRunUsabilitySession(session, protocol),
  );
  const participantIds = validations.map((result) => result.participant_id);
  if (new Set(participantIds).size !== participantIds.length) {
    throw new TypeError(
      "Each aggregate session must use a unique opaque participant ID.",
    );
  }

  const platforms = {};
  const installationSources = {};
  const sessionModes = {};
  const firstHesitations = { none: 0 };
  const firstHesitationTasks = { none: 0 };
  const firstSuccesses = { none: 0 };
  const firstSuccessSeconds = [];
  const assumptions = { none: 0 };
  const assumptionFirstTasks = { none: 0 };
  const stoppingReasons = {};
  const stoppingPoints = {};
  const taskRows = protocol.tasks.map((task) => ({
    task_id: task.id,
    title: task.title,
    attempted: 0,
    completed: 0,
    blocked: 0,
    skipped: 0,
    assisted: 0,
    elapsed_seconds: [],
  }));

  for (const session of sessions) {
    increment(platforms, session.environment.platform);
    increment(installationSources, session.environment.installation_source);
    increment(sessionModes, session.environment.session_mode);
    const hesitation = session.observations.first_hesitation;
    increment(
      firstHesitations,
      hesitation.status === "none" ? "none" : hesitation.category,
    );
    increment(
      firstHesitationTasks,
      hesitation.status === "none" ? "none" : hesitation.task_id,
    );
    const firstSuccess = session.observations.first_success;
    increment(
      firstSuccesses,
      firstSuccess.status === "none" ? "none" : firstSuccess.task_id,
    );
    if (firstSuccess.status === "observed") {
      firstSuccessSeconds.push(firstSuccess.elapsed_seconds);
    }
    const misleading = session.observations.misleading_assumptions;
    if (!misleading.observed) {
      increment(assumptions, "none");
      increment(assumptionFirstTasks, "none");
    } else {
      for (const category of misleading.categories) increment(assumptions, category);
      increment(assumptionFirstTasks, misleading.first_task_id);
    }
    increment(stoppingReasons, session.observations.stopping_point.reason);
    increment(stoppingPoints, session.observations.stopping_point.task_id);
    for (const [index, task] of session.tasks.entries()) {
      const row = taskRows[index];
      increment(row, task.outcome);
      if (task.outcome !== "skipped") {
        row.attempted += 1;
        row.elapsed_seconds.push(task.elapsed_seconds);
      }
      if (task.assistance !== "none") row.assisted += 1;
    }
  }

  const completedAll = sessions.filter((session) =>
    session.tasks.every((task) => task.outcome === "completed"),
  ).length;
  const publicTaskRows = taskRows.map((row) => ({
    task_id: row.task_id,
    title: row.title,
    attempted: row.attempted,
    completed: row.completed,
    blocked: row.blocked,
    skipped: row.skipped,
    assisted: row.assisted,
    completion_rate_percent: rate(row.completed, row.attempted),
    median_elapsed_seconds: median(row.elapsed_seconds),
  }));
  const repeatedFailures = publicTaskRows
    .filter((row) => row.blocked >= 2)
    .map((row) => ({
      task_id: row.task_id,
      title: row.title,
      blocked_sessions: row.blocked,
    }));
  const threshold =
    FIRST_RUN_USABILITY_CLAIM_THRESHOLDS.minimum_independent_newcomer_sessions;
  const gateReady = sessions.length >= threshold;
  const missingSessions = Math.max(0, threshold - sessions.length);

  return {
    report_version: "first-run-usability-summary/1",
    generated_at: generatedAt,
    protocol: {
      protocol_version: protocol.protocol_version,
      protocol_sha256: protocol.protocol_sha256,
      task_count: protocol.tasks.length,
      uses_personal_music_data: false,
    },
    methodology: {
      population:
        "Independent newcomers who did not build Moondog, using a clean install and only built-in or Moondog-generated fictional data.",
      task_order: protocol.tasks.map((task) => ({
        task_id: task.id,
        title: task.title,
        success_criterion: task.success_criterion,
      })),
      interpretation:
        "Observed task completion and bounded misunderstanding categories describe this sample only. They do not establish broad market usability.",
    },
    sample: {
      independent_newcomer_sessions: sessions.length,
      completed_all_tasks: completedAll,
      completed_all_rate_percent: rate(completedAll, sessions.length),
      platforms,
      installation_sources: installationSources,
      session_modes: sessionModes,
    },
    outcomes: {
      tasks: publicTaskRows,
      first_hesitation_categories: firstHesitations,
      first_hesitation_tasks: firstHesitationTasks,
      first_success_tasks: firstSuccesses,
      median_seconds_to_first_success: median(firstSuccessSeconds),
      misleading_assumption_categories: assumptions,
      misleading_assumption_first_tasks: assumptionFirstTasks,
      stopping_reasons: stoppingReasons,
      stopping_points: stoppingPoints,
      repeated_failures: repeatedFailures,
    },
    evidence_gate: {
      ready: gateReady,
      minimum_independent_newcomer_sessions: threshold,
      observed_independent_newcomer_sessions: sessions.length,
      missing_sessions: missingSessions,
      gaps: gateReady
        ? []
        : [
            `Complete ${missingSessions} more independent newcomer session${missingSessions === 1 ? "" : "s"}.`,
          ],
    },
    privacy: {
      classification: "public_aggregate",
      contains_participant_ids: false,
      contains_free_text_notes: false,
      contains_music_data: false,
      omitted:
        "Participant IDs, exact session timestamps, free-text observations, artifact paths, credentials, and music data are omitted.",
    },
  };
}

export function summarizeFirstRunUsabilitySummary(report) {
  if (report?.report_version !== "first-run-usability-summary/1") {
    throw new TypeError("Unsupported first-run usability summary version.");
  }
  const lines = [
    "First-run usability summary",
    `Independent newcomer sessions: ${report.sample.independent_newcomer_sessions}`,
    `Completed every task: ${report.sample.completed_all_tasks}/${report.sample.independent_newcomer_sessions} (${report.sample.completed_all_rate_percent}%)`,
    `Evidence gate: ${report.evidence_gate.ready ? "READY" : "NOT READY"}`,
    `Median seconds to first success: ${report.outcomes.median_seconds_to_first_success ?? "not observed"}`,
  ];
  for (const task of report.outcomes.tasks) {
    lines.push(
      `${task.title}: ${task.completed}/${task.attempted} completed, ${task.blocked} blocked, ${task.assisted} assisted`,
    );
  }
  if (report.outcomes.repeated_failures.length === 0) {
    lines.push("Repeated blocked tasks: none observed");
  } else {
    lines.push(
      `Repeated blocked tasks: ${report.outcomes.repeated_failures.map((row) => `${row.title} (${row.blocked_sessions})`).join(", ")}`,
    );
  }
  for (const gap of report.evidence_gate.gaps) lines.push(`Gap: ${gap}`);
  lines.push(
    "Privacy: aggregate counts only; participant IDs and private notes are omitted.",
  );
  return lines.join("\n");
}
