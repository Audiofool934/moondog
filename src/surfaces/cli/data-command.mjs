import {
  LOCAL_MUSIC_DATA_SCOPES,
  exportLocalMusicData,
  inspectLocalMusicData,
  resetLocalMusicData,
  resolveLocalMusicDataPaths,
} from "../../profile/local-music-data.mjs";
import { sanitizeTerminalText } from "./format-output.mjs";

export function dataHelpText() {
  return `# Moondog local music data

Commands:

- \`moondog data inspect --scope <listening|apple|profile> [--json]\` - preview the selected local state and get its exact reset token
- \`moondog data export --scope <listening|apple|profile> --output <directory> [--json]\` - create a private, checksummed snapshot without changing the source
- \`moondog data reset --scope <listening|apple|profile> --confirm <token> [--json]\` - archive the selected state without deleting it

Scopes are always explicit.
The \`profile\` scope combines listening history, the Spotify resolution cache, Tasteprints, and Apple import/projection state.
OAuth credentials, model settings, conversation memory, Spotify client configuration, and original provider ZIPs are excluded.
Reset uses recoverable sibling archives and never silently deletes local music data.`;
}

function parseDataArguments(args) {
  const values = [...args];
  const action = values.shift();
  if (action === "-h" || action === "--help") {
    return { action: "help", scope: null, confirmation: null };
  }
  let scope = null;
  let confirmation = null;
  while (values.length > 0) {
    const option = values.shift();
    if (option !== "--scope" && option !== "--confirm") {
      throw new Error(`Unknown data option: ${option}`);
    }
    const value = values.shift();
    if (!value || value.startsWith("--")) {
      throw new Error(`The ${option} option requires a value.`);
    }
    if (option === "--scope") {
      if (scope !== null) {
        throw new Error("The --scope option may be provided only once.");
      }
      scope = value;
    } else {
      if (confirmation !== null) {
        throw new Error("The --confirm option may be provided only once.");
      }
      confirmation = value;
    }
  }
  return { action, scope, confirmation };
}

function requireScope(scope) {
  if (!LOCAL_MUSIC_DATA_SCOPES.includes(scope)) {
    throw new Error(
      `The data command requires --scope ${LOCAL_MUSIC_DATA_SCOPES.join("|")}.`,
    );
  }
  return scope;
}

function writeLine(output, value = "") {
  output.write(`${sanitizeTerminalText(value)}\n`);
}

function formatBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0) return "unknown";
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}

function formatInspection(value) {
  const lines = [
    "# Local music data",
    "",
    `- Scope: ${value.scope}`,
    `- State: ${value.state}`,
    `- Subject: ${value.subject_id ?? "not bound"}`,
    `- Selected data: ${value.totals.files.toLocaleString("en-US")} files, ${formatBytes(value.totals.bytes)}`,
    "- Writes: none",
    "",
    "## Components",
    "",
    ...value.components.map(
      (component) =>
        `- ${component.id}: ${component.state}, ${component.files.toLocaleString("en-US")} files, ${formatBytes(component.bytes)} - ${component.path}`,
    ),
    "",
    "## Excluded",
    "",
    ...value.excluded.map((item) => `- ${item}`),
  ];
  if (value.state === "empty") {
    lines.push("", "No selected local music data is available to export or reset.");
  } else if (value.state === "subject_conflict") {
    lines.push(
      "",
      "The selected sources belong to different local music subjects.",
      "Export and reset are disabled until that conflict is reviewed.",
    );
  } else {
    lines.push(
      "",
      "Reset preview:",
      `moondog data reset --scope ${value.scope} --confirm ${value.reset_confirmation}`,
      "This archives the selected state and deletes nothing.",
    );
  }
  return lines.join("\n");
}

function formatExport(value) {
  return [
    "Created a private local music data export.",
    `Scope: ${value.scope}`,
    `Path: ${value.path}`,
    `Contents: ${value.files.toLocaleString("en-US")} files, ${formatBytes(value.bytes)}`,
    `Manifest SHA-256: ${value.manifest_sha256}`,
    "Source changed: no",
    "OAuth, configuration, memory, and original provider ZIPs were not included.",
  ].join("\n");
}

function formatReset(value) {
  return [
    "Archived the selected local music data without deleting files.",
    `Scope: ${value.scope}`,
    `Reset ID: ${value.reset_id}`,
    `Manifest: ${value.manifest_path}`,
    "Archives:",
    ...value.archives.map((archive) => `- ${archive.component}: ${archive.path}`),
    "Deletion: none",
    "OAuth, configuration, memory, and original provider ZIPs were not changed.",
  ].join("\n");
}

export async function runDataCommand({
  args,
  json = false,
  outputPath = null,
  environment = process.env,
  paths = null,
  output = process.stdout,
  now,
} = {}) {
  const options = parseDataArguments(args ?? []);
  if (!options.action || options.action === "help") {
    if (options.scope || options.confirmation || outputPath || json) {
      throw new Error("Usage: moondog data help.");
    }
    writeLine(output, dataHelpText());
    return;
  }
  if (!new Set(["inspect", "export", "reset"]).has(options.action)) {
    throw new Error(`Unknown data command: ${options.action}`);
  }
  const scope = requireScope(options.scope);
  const resolvedPaths = paths ?? resolveLocalMusicDataPaths({ environment });
  let value;
  if (options.action === "inspect") {
    if (options.confirmation || outputPath) {
      throw new Error(
        "Usage: moondog data inspect --scope <listening|apple|profile> [--json].",
      );
    }
    value = await inspectLocalMusicData({ scope, paths: resolvedPaths });
  } else if (options.action === "export") {
    if (options.confirmation || !outputPath) {
      throw new Error(
        "Usage: moondog data export --scope <listening|apple|profile> --output <directory> [--json].",
      );
    }
    value = await exportLocalMusicData({
      scope,
      outputPath,
      paths: resolvedPaths,
      ...(now ? { now } : {}),
    });
  } else {
    if (!options.confirmation || outputPath) {
      throw new Error(
        "Usage: moondog data reset --scope <listening|apple|profile> --confirm <token> [--json].",
      );
    }
    value = await resetLocalMusicData({
      scope,
      confirmation: options.confirmation,
      paths: resolvedPaths,
      ...(now ? { now } : {}),
    });
  }
  writeLine(
    output,
    json
      ? JSON.stringify(value, null, 2)
      : options.action === "inspect"
        ? formatInspection(value)
        : options.action === "export"
          ? formatExport(value)
          : formatReset(value),
  );
  return value;
}
