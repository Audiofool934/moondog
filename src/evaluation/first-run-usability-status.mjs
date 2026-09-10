import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  FIRST_RUN_USABILITY_CLAIM_THRESHOLDS,
  FIRST_RUN_USABILITY_PROTOCOL_VERSIONS,
  validateFirstRunUsabilityProtocol,
  validateFirstRunUsabilitySession,
} from "./first-run-usability.mjs";

function isUsabilityArtifactName(name) {
  return (
    name.startsWith("first-run-usability-") ||
    name.startsWith("completed-first-run-usability-")
  );
}

function formProtocolId(name) {
  const match = /^first-run-usability-(fru-[a-f0-9]{16})\.html$/u.exec(name);
  return match?.[1] ?? null;
}

function sanitizedIssue(kind, code) {
  const messages = {
    invalid_json: "The JSON artifact could not be parsed.",
    duplicate_protocol:
      "More than one protocol artifact has the same protocol identity.",
    invalid_protocol: "The protocol artifact did not pass bounded validation.",
    invalid_public_summary:
      "The public summary artifact did not pass its privacy contract.",
    unsupported_artifact:
      "The JSON artifact has no supported first-run usability version.",
    missing_protocol:
      "A completed session has no matching valid protocol artifact.",
    invalid_session:
      "The completed session did not pass bounded protocol validation.",
  };
  return {
    artifact_kind: kind,
    code,
    message: messages[code] ?? "The artifact did not pass bounded validation.",
  };
}

async function readDirectoryEntries(inputDirectory) {
  try {
    return {
      exists: true,
      entries: await readdir(inputDirectory, { withFileTypes: true }),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, entries: [] };
    throw error;
  }
}

function validatePublicSummary(summary) {
  if (summary?.report_version !== "first-run-usability-summary/1") {
    throw new TypeError("Unsupported first-run usability summary version.");
  }
  if (
    summary.privacy?.classification !== "public_aggregate" ||
    summary.privacy?.contains_participant_ids !== false ||
    summary.privacy?.contains_free_text_notes !== false ||
    summary.privacy?.contains_music_data !== false
  ) {
    throw new TypeError("Usability summary privacy boundary is invalid.");
  }
}

function nextActions(status) {
  if (!status.directory_exists || status.counts.protocols === 0) {
    return [
      {
        code: "create_protocol",
        message:
          "Create the bounded first-run protocol and local observer form before recruiting participants.",
      },
    ];
  }
  const actions = [];
  const missingForms = status.protocols.filter((row) => !row.form_ready).length;
  if (missingForms > 0) {
    actions.push({
      code: "create_missing_form",
      message: `Regenerate ${missingForms} missing local observer form${missingForms === 1 ? "" : "s"} from the matching protocol JSON.`,
    });
  }
  if (status.counts.invalid_artifacts > 0) {
    actions.push({
      code: "resolve_invalid_artifacts",
      message: `Resolve ${status.counts.invalid_artifacts} invalid usability artifact${status.counts.invalid_artifacts === 1 ? "" : "s"} before aggregating results.`,
    });
  }
  if (status.counts.duplicate_participant_sessions > 0) {
    actions.push({
      code: "resolve_duplicate_participants",
      message:
        "Exclude repeated sessions from the same opaque participant before creating a public aggregate.",
    });
  }
  if (!status.evidence_gate.ready) {
    const best = status.protocols.reduce(
      (maximum, row) => Math.max(maximum, row.unique_newcomer_sessions),
      0,
    );
    const threshold =
      FIRST_RUN_USABILITY_CLAIM_THRESHOLDS.minimum_independent_newcomer_sessions;
    const missing = Math.max(0, threshold - best);
    actions.push({
      code: "complete_more_sessions",
      message: `Complete ${missing} more independent newcomer session${missing === 1 ? "" : "s"} against one protocol, recording first hesitation, first success, and misleading assumptions.`,
    });
  } else {
    actions.push({
      code: "create_public_aggregate",
      message:
        "Create and review an aggregate-only summary. Keep completed session JSON private.",
    });
  }
  return actions;
}

export async function inspectFirstRunUsabilityDirectory(
  inputDirectory = "runs",
  { generatedAt = new Date().toISOString() } = {},
) {
  if (typeof generatedAt !== "string" || Number.isNaN(Date.parse(generatedAt))) {
    throw new TypeError("generatedAt must be an ISO timestamp.");
  }
  const resolvedDirectory = path.resolve(inputDirectory);
  const directory = await readDirectoryEntries(resolvedDirectory);
  const relevantEntries = directory.entries
    .filter((entry) => entry.isFile() && isUsabilityArtifactName(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const protocols = new Map();
  const forms = new Set();
  const pendingSessions = [];
  const summaries = [];
  const issues = [];

  for (const entry of relevantEntries) {
    const formId = formProtocolId(entry.name);
    if (formId) {
      forms.add(formId);
      continue;
    }
    if (!entry.name.endsWith(".json")) continue;
    let value;
    try {
      value = JSON.parse(await readFile(path.join(resolvedDirectory, entry.name), "utf8"));
    } catch (error) {
      issues.push(sanitizedIssue("json", "invalid_json"));
      continue;
    }
    if (FIRST_RUN_USABILITY_PROTOCOL_VERSIONS.includes(value?.protocol_version)) {
      try {
        validateFirstRunUsabilityProtocol(value);
        if (protocols.has(value.protocol_id)) {
          issues.push(
            sanitizedIssue("protocol", "duplicate_protocol"),
          );
        } else {
          protocols.set(value.protocol_id, value);
        }
      } catch (error) {
        issues.push(sanitizedIssue("protocol", "invalid_protocol"));
      }
      continue;
    }
    if (value?.session_version === "first-run-usability-session/1") {
      pendingSessions.push(value);
      continue;
    }
    if (value?.report_version === "first-run-usability-summary/1") {
      try {
        validatePublicSummary(value);
        summaries.push(value);
      } catch (error) {
        issues.push(sanitizedIssue("public_summary", "invalid_public_summary"));
      }
      continue;
    }
    issues.push(
      sanitizedIssue("json", "unsupported_artifact"),
    );
  }

  const sessionsByProtocol = new Map();
  for (const session of pendingSessions) {
    const protocol = protocols.get(session.protocol_id);
    if (!protocol) {
      issues.push(
        sanitizedIssue("session", "missing_protocol"),
      );
      continue;
    }
    try {
      const validation = validateFirstRunUsabilitySession(session, protocol);
      const rows = sessionsByProtocol.get(protocol.protocol_id) ?? [];
      rows.push({ session, participant_id: validation.participant_id });
      sessionsByProtocol.set(protocol.protocol_id, rows);
    } catch (error) {
      issues.push(sanitizedIssue("session", "invalid_session"));
    }
  }

  let duplicateParticipantSessions = 0;
  const threshold =
    FIRST_RUN_USABILITY_CLAIM_THRESHOLDS.minimum_independent_newcomer_sessions;
  const protocolRows = [...protocols.values()]
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
    .map((protocol) => {
      const sessions = sessionsByProtocol.get(protocol.protocol_id) ?? [];
      const participantCounts = new Map();
      for (const row of sessions) {
        participantCounts.set(
          row.participant_id,
          (participantCounts.get(row.participant_id) ?? 0) + 1,
        );
      }
      const duplicates = [...participantCounts.values()].reduce(
        (total, count) => total + Math.max(0, count - 1),
        0,
      );
      duplicateParticipantSessions += duplicates;
      const uniqueSessions = participantCounts.size;
      const rowIssues = [];
      if (!forms.has(protocol.protocol_id)) rowIssues.push("missing_observer_form");
      if (sessions.length === 0) rowIssues.push("no_completed_sessions");
      if (duplicates > 0) rowIssues.push("duplicate_participant_sessions");
      if (uniqueSessions < threshold) rowIssues.push("evidence_gate_incomplete");
      return {
        protocol_id: protocol.protocol_id,
        form_ready: forms.has(protocol.protocol_id),
        valid_sessions: sessions.length,
        unique_newcomer_sessions: uniqueSessions,
        duplicate_participant_sessions: duplicates,
        evidence_gate: {
          ready: uniqueSessions >= threshold,
          observed: uniqueSessions,
          required: threshold,
          missing: Math.max(0, threshold - uniqueSessions),
        },
        issues: rowIssues,
      };
    });

  const status = {
    status_version: "first-run-usability-status/1",
    generated_at: generatedAt,
    directory_exists: directory.exists,
    privacy: {
      classification: "private_safe_operational_status",
      contains_participant_ids: false,
      contains_free_text_notes: false,
      contains_absolute_paths: false,
      contains_music_data: false,
    },
    counts: {
      protocols: protocols.size,
      observer_forms: forms.size,
      valid_sessions: [...sessionsByProtocol.values()].reduce(
        (total, rows) => total + rows.length,
        0,
      ),
      unique_newcomers: protocolRows.reduce(
        (total, row) => total + row.unique_newcomer_sessions,
        0,
      ),
      duplicate_participant_sessions: duplicateParticipantSessions,
      public_summaries: summaries.length,
      invalid_artifacts: issues.length,
    },
    evidence_gate: {
      ready: protocolRows.some((row) => row.evidence_gate.ready),
      minimum_independent_newcomer_sessions_per_protocol: threshold,
      ready_protocols: protocolRows.filter((row) => row.evidence_gate.ready).length,
    },
    protocols: protocolRows,
    invalid_artifacts: issues,
    next_actions: [],
  };
  status.next_actions = nextActions(status);
  return status;
}

export function summarizeFirstRunUsabilityStatus(status) {
  if (status?.status_version !== "first-run-usability-status/1") {
    throw new TypeError("Unsupported first-run usability status version.");
  }
  const lines = [
    "First-run usability status",
    `Protocols: ${status.counts.protocols}`,
    `Observer forms: ${status.counts.observer_forms}`,
    `Valid sessions: ${status.counts.valid_sessions}`,
    `Unique newcomers: ${status.counts.unique_newcomers}`,
    `Invalid artifacts: ${status.counts.invalid_artifacts}`,
    `Evidence gate: ${status.evidence_gate.ready ? "READY" : "NOT READY"}`,
  ];
  for (const protocol of status.protocols) {
    lines.push(
      `${protocol.protocol_id}: ${protocol.unique_newcomer_sessions}/${protocol.evidence_gate.required} unique newcomer sessions, form ${protocol.form_ready ? "ready" : "missing"} - ${protocol.evidence_gate.ready ? "READY" : "NOT READY"}`,
    );
  }
  for (const action of status.next_actions) {
    lines.push(`Next: ${action.message}`);
  }
  lines.push(
    "Privacy: status output omits participant IDs, private notes, paths, and music data.",
  );
  return lines.join("\n");
}
