import { readListenBrainzHistoryFile } from "../../integrations/listenbrainz/history-file.mjs";
import { sanitizeTerminalText } from "./format-output.mjs";

export function listenBrainzHelpText() {
  return `# Moondog ListenBrainz

Commands:

- \`moondog listenbrainz import-history <listen-history.json> [--json]\`

Accepted files are official ListenBrainz GET-listens responses or \`single\` and \`import\` submission JSON.
The import is local and offline.
Moondog does not retain the ListenBrainz username, client metadata, URLs, tags, or raw JSON.`;
}

function commandError(message) {
  const error = new Error(message);
  error.code = "listenbrainz_command_invalid";
  return error;
}

function writeLine(stream, value = "") {
  stream.write(`${sanitizeTerminalText(value)}\n`);
}

function parseArguments(args, inheritedJson) {
  const values = [...(args ?? [])];
  const jsonIndexes = values
    .map((value, index) => (value === "--json" ? index : -1))
    .filter((index) => index !== -1);
  if (
    jsonIndexes.length > 1 ||
    (jsonIndexes.length === 1 && jsonIndexes[0] !== values.length - 1)
  ) {
    throw commandError(
      "The --json option must appear once at the end of the ListenBrainz command.",
    );
  }
  const json = Boolean(inheritedJson || jsonIndexes.length === 1);
  if (jsonIndexes.length === 1) values.pop();
  const action = values[0];
  const rest = values.slice(1);
  if (action === "-h" || action === "--help") {
    return { action: "help", rest, json };
  }
  return { action, rest, json };
}

function exactArguments(action, rest, count, usage) {
  if (rest.length !== count) {
    throw commandError(`Usage: moondog listenbrainz ${usage ?? action}.`);
  }
}

function formatImport(value) {
  return [
    "# Your ListenBrainz history is in",
    `- ${value.input_records ?? 0} listens in the file, from ${value.earliest_occurred_at?.slice(0, 10) ?? "an unknown date"} to ${value.latest_occurred_at?.slice(0, 10) ?? "an unknown date"}`,
    value.already_imported
      ? "- You imported this file before, so nothing new was added"
      : `- ${value.inserted_events ?? 0} new${value.duplicate_events ? `, ${value.duplicate_events} I already had` : ""}`,
    `- ${value.inserted_track_refs ?? 0} songs new to your profile; ListenBrainz matched ${value.mapped_track_refs ?? 0} to MusicBrainz`,
    `- Listening time is known for ${value.events_with_played_ms ?? 0} of them`,
    "- The file itself wasn't copied, and no account details were kept",
    `- File fingerprint: ${value.archive_sha256 ?? "unavailable"}`,
  ].join("\n");
}

export async function runListenBrainzCommand({
  args = [],
  json = false,
  stdout = process.stdout,
  historyStore = null,
  subjectId = null,
  now = Date.now,
  historyFileImporter = readListenBrainzHistoryFile,
} = {}) {
  const options = parseArguments(args, json);
  const action = options.action;
  if (!action || action === "help") {
    exactArguments("help", options.rest, 0, "help");
    writeLine(stdout, listenBrainzHelpText());
    return;
  }
  if (action !== "import-history") {
    throw commandError(`Unknown ListenBrainz command: ${action}`);
  }
  exactArguments(
    action,
    options.rest,
    1,
    "import-history <listen-history.json>",
  );
  if (!historyStore || typeof historyStore.ingestImport !== "function") {
    throw commandError("ListenBrainz history storage is unavailable.");
  }
  if (typeof subjectId !== "string" || !subjectId.trim()) {
    throw commandError(
      "A trusted local music subject is required for ListenBrainz history import.",
    );
  }
  const currentTime = now();
  if (!Number.isFinite(currentTime)) {
    throw commandError("ListenBrainz import time is unavailable.");
  }
  const bundle = await historyFileImporter({
    filePath: options.rest[0],
    subjectId,
    capturedAt: new Date(currentTime).toISOString(),
  });
  const receipt = historyStore.ingestImport(bundle);
  const result = {
    provider: "listenbrainz",
    ...receipt,
    mapped_track_refs: bundle.track_refs.filter(
      (track) => track.identity_status === "resolved",
    ).length,
    events_with_played_ms: bundle.listening_events.filter(
      (event) => Number.isSafeInteger(event.played_ms),
    ).length,
    source_file_retained: false,
    direct_account_identifiers_retained: false,
  };
  writeLine(
    stdout,
    options.json ? JSON.stringify(result, null, 2) : formatImport(result),
  );
  return result;
}
