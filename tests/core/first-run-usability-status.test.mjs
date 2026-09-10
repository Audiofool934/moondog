import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  computeFirstRunUsabilityProtocolDigest,
  createFirstRunUsabilityProtocol,
} from "../../src/evaluation/first-run-usability.mjs";
import { renderFirstRunUsabilityForm } from "../../src/evaluation/first-run-usability-form.mjs";
import {
  inspectFirstRunUsabilityDirectory,
  summarizeFirstRunUsabilityStatus,
} from "../../src/evaluation/first-run-usability-status.mjs";

const execFileAsync = promisify(execFile);

function session(protocol, participantId) {
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
      platform: "macos",
      installation_source: "clean_source_checkout",
      node_major: 24,
      session_mode: "remote_screen_share",
    },
    tasks: protocol.tasks.map((task, index) => ({
      task_id: task.id,
      outcome: "completed",
      elapsed_seconds: 20 + index,
      assistance: "none",
      note: index === 0 ? `PRIVATE note for ${participantId}` : "",
    })),
    observations: {
      first_hesitation: {
        status: "none",
        task_id: null,
        category: null,
        note: "",
      },
      first_success: {
        status: "observed",
        task_id: protocol.tasks[0].id,
        elapsed_seconds: 20,
      },
      misleading_assumptions: {
        observed: false,
        categories: [],
        first_task_id: null,
        note: "",
      },
      stopping_point: {
        task_id: "completed_all",
        reason: "completed_all",
        note: "",
      },
    },
  };
}

async function writeProtocolBundle(root, { withForm = true } = {}) {
  const protocol = createFirstRunUsabilityProtocol({
    generatedAt: "2026-09-03T08:00:00.000Z",
  });
  const prefix = `first-run-usability-${protocol.protocol_id}`;
  await writeFile(
    path.join(root, `${prefix}.protocol.json`),
    `${JSON.stringify(protocol, null, 2)}\n`,
    "utf8",
  );
  if (withForm) {
    await writeFile(
      path.join(root, `${prefix}.html`),
      renderFirstRunUsabilityForm(protocol),
      "utf8",
    );
  }
  return { protocol, prefix };
}

test("usability status reaches its gate with three unique newcomers and leaks no private notes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-usability-ready-"));
  try {
    const { protocol } = await writeProtocolBundle(root);
    for (const participantId of ["newcomer-alpha", "newcomer-beta", "newcomer-gamma"]) {
      await writeFile(
        path.join(
          root,
          `completed-first-run-usability-${protocol.protocol_id}-${participantId}.json`,
        ),
        `${JSON.stringify(session(protocol, participantId), null, 2)}\n`,
        "utf8",
      );
    }

    const status = await inspectFirstRunUsabilityDirectory(root, {
      generatedAt: "2026-09-03T13:00:00.000Z",
    });
    const serialized = JSON.stringify(status);
    const summary = summarizeFirstRunUsabilityStatus(status);

    assert.equal(status.counts.protocols, 1);
    assert.equal(status.counts.observer_forms, 1);
    assert.equal(status.counts.valid_sessions, 3);
    assert.equal(status.counts.unique_newcomers, 3);
    assert.equal(status.evidence_gate.ready, true);
    assert.equal(status.protocols[0].evidence_gate.ready, true);
    assert.equal(status.next_actions.at(-1).code, "create_public_aggregate");
    assert.doesNotMatch(
      serialized,
      /newcomer-alpha|newcomer-beta|newcomer-gamma|PRIVATE note|moondog-usability-ready/u,
    );
    assert.match(summary, /3\/3 unique newcomer sessions/u);
    assert.match(summary, /Evidence gate: READY/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usability status reports missing form, duplicate participant, and invalid session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-usability-invalid-"));
  try {
    const { protocol } = await writeProtocolBundle(root, { withForm: false });
    const valid = session(protocol, "newcomer-alpha");
    const invalid = session(protocol, "newcomer-invalid");
    invalid.privacy.no_personal_music_data = false;
    for (const [index, value] of [valid, valid, invalid].entries()) {
      await writeFile(
        path.join(root, `completed-first-run-usability-${index}.json`),
        `${JSON.stringify(value, null, 2)}\n`,
        "utf8",
      );
    }
    await writeFile(
      path.join(
        root,
        "completed-first-run-usability-newcomer-secret.json",
      ),
      '{"private_note":"VERY SECRET",,}\n',
      "utf8",
    );

    const status = await inspectFirstRunUsabilityDirectory(root);
    const serialized = JSON.stringify(status);

    assert.equal(status.counts.valid_sessions, 2);
    assert.equal(status.counts.unique_newcomers, 1);
    assert.equal(status.counts.duplicate_participant_sessions, 1);
    assert.equal(status.counts.invalid_artifacts, 2);
    assert.deepEqual(status.protocols[0].issues, [
      "missing_observer_form",
      "duplicate_participant_sessions",
      "evidence_gate_incomplete",
    ]);
    assert.ok(
      status.next_actions.some(
        (action) => action.code === "resolve_duplicate_participants",
      ),
    );
    assert.deepEqual(
      new Set(status.invalid_artifacts.map((issue) => issue.code)),
      new Set(["invalid_json", "invalid_session"]),
    );
    assert.doesNotMatch(serialized, /newcomer-secret|VERY SECRET/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usability create command writes a private protocol and self-contained form", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-usability-cli-"));
  try {
    const scriptPath = path.resolve("scripts/evaluate-usability.mjs");
    const { stdout } = await execFileAsync(process.execPath, [
      scriptPath,
      "create",
      "--output-dir",
      root,
      "--json",
    ]);
    const result = JSON.parse(stdout);
    const protocol = JSON.parse(await readFile(result.protocol, "utf8"));
    const html = await readFile(result.observer_form, "utf8");
    const protocolMode = (await stat(result.protocol)).mode & 0o777;
    const formMode = (await stat(result.observer_form)).mode & 0o777;

    assert.equal(result.protocol_id, protocol.protocol_id);
    assert.equal(result.tasks, 8);
    assert.equal(protocolMode, 0o600);
    assert.equal(formMode, 0o600);
    assert.match(html, /connect-src 'none'/u);
    assert.doesNotMatch(html, /https?:\/\//u);

    const sessionPath = path.join(
      root,
      `completed-first-run-usability-${protocol.protocol_id}-newcomer-cli.json`,
    );
    await writeFile(
      sessionPath,
      `${JSON.stringify(session(protocol, "newcomer-cli"), null, 2)}\n`,
      "utf8",
    );
    const validationRun = await execFileAsync(process.execPath, [
      scriptPath,
      "validate",
      "--protocol",
      result.protocol,
      "--session",
      sessionPath,
      "--json",
    ]);
    const validation = JSON.parse(validationRun.stdout);
    assert.equal(validation.valid, true);
    assert.equal(validation.sessions[0].completed_tasks, 8);
    assert.doesNotMatch(validationRun.stdout, /newcomer-cli|PRIVATE/u);

    const summaryPath = path.join(root, "first-run-usability-summary-cli.json");
    const summaryRun = await execFileAsync(process.execPath, [
      scriptPath,
      "summarize",
      "--protocol",
      result.protocol,
      "--session",
      sessionPath,
      "--output",
      summaryPath,
      "--json",
    ]);
    const summary = JSON.parse(summaryRun.stdout);
    assert.equal(summary.sample.independent_newcomer_sessions, 1);
    assert.equal(summary.evidence_gate.ready, false);
    assert.equal((await stat(summaryPath)).mode & 0o777, 0o600);
    assert.doesNotMatch(
      await readFile(summaryPath, "utf8"),
      /newcomer-cli|PRIVATE|2026-09-03T10:00/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usability status treats a missing directory as an empty setup", async () => {
  const root = path.join(
    tmpdir(),
    `moondog-usability-missing-${process.pid}-${Date.now()}`,
  );
  const status = await inspectFirstRunUsabilityDirectory(root);

  assert.equal(status.directory_exists, false);
  assert.equal(status.counts.protocols, 0);
  assert.equal(status.evidence_gate.ready, false);
  assert.equal(status.next_actions[0].code, "create_protocol");
});

test("usability status continues to recognize a version-one protocol", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-usability-v1-"));
  try {
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
    await writeFile(
      path.join(root, `first-run-usability-${protocol.protocol_id}.protocol.json`),
      `${JSON.stringify(protocol, null, 2)}\n`,
      "utf8",
    );

    const status = await inspectFirstRunUsabilityDirectory(root);
    assert.equal(status.counts.protocols, 1);
    assert.equal(status.counts.invalid_artifacts, 0);
    assert.equal(status.protocols[0].valid_sessions, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
