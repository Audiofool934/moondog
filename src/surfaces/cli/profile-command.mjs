import { access } from "node:fs/promises";

import {
  openListeningHistoryStore,
  resolveListeningHistoryPath,
} from "../../profile/listening-history-store.mjs";
import { sanitizeTerminalText } from "./format-output.mjs";

export function profileCorrectionHelpText(commandPrefix = "moondog profile") {
  return `# Moondog profile corrections

Commands:

- \`${commandPrefix} corrections [--all] [--json]\` - list active corrections, or include superseded and retracted history
- \`${commandPrefix} correct --artist <name> (--like|--avoid) [--note <text>] [--json]\` - record an explicit artist stance
- \`${commandPrefix} correct --track <title> --by <artist> (--like|--avoid) [--note <text>] [--json]\` - record an explicit track stance
- \`${commandPrefix} retract <correction-id> [--json]\` - retract one active correction

Corrections are direct, typed, local TasteEvent records.
They outrank ambiguous behavioral and provider signals without rewriting listening history.
Every correction is inspectable, supersedable, and retractable.`;
}

function optionValue(values, option) {
  const indexes = values
    .map((value, index) => (value === option ? index : -1))
    .filter((index) => index !== -1);
  if (indexes.length > 1) {
    throw new Error(`The ${option} option may be provided only once.`);
  }
  if (indexes.length === 0) return null;
  const index = indexes[0];
  const value = values[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`The ${option} option requires a value.`);
  }
  values.splice(index, 2);
  return value;
}

function switchOption(values, option) {
  const indexes = values
    .map((value, index) => (value === option ? index : -1))
    .filter((index) => index !== -1);
  if (indexes.length > 1) {
    throw new Error(`The ${option} option may be provided only once.`);
  }
  if (indexes.length === 0) return false;
  values.splice(indexes[0], 1);
  return true;
}

function parseProfileArguments(args) {
  const values = [...args];
  const action = values.shift();
  if (action === "-h" || action === "--help") {
    return { action: "help", values: [] };
  }
  if (action === "corrections") {
    const includeInactive = switchOption(values, "--all");
    if (values.length > 0) {
      throw new Error(`Unknown profile corrections option: ${values[0]}`);
    }
    return { action, includeInactive };
  }
  if (action === "correct") {
    const artist = optionValue(values, "--artist");
    const track = optionValue(values, "--track");
    const by = optionValue(values, "--by");
    const note = optionValue(values, "--note");
    const like = switchOption(values, "--like");
    const avoid = switchOption(values, "--avoid");
    if (values.length > 0) {
      throw new Error(`Unknown profile correction option: ${values[0]}`);
    }
    if (Boolean(artist) === Boolean(track)) {
      throw new Error("Choose exactly one correction target: --artist or --track.");
    }
    if (track && !by) {
      throw new Error("A --track correction requires --by <artist>.");
    }
    if (artist && by) {
      throw new Error("The --by option is valid only with --track.");
    }
    if (like === avoid) {
      throw new Error("Choose exactly one listener stance: --like or --avoid.");
    }
    return {
      action,
      entityType: artist ? "artist" : "track",
      label: artist ?? track,
      artistCredit: track ? by : undefined,
      stance: like ? "like" : "avoid",
      note: note ?? undefined,
    };
  }
  if (action === "retract") {
    if (values.length !== 1 || values[0].startsWith("--")) {
      throw new Error("Usage: moondog profile retract <correction-id> [--json].");
    }
    return { action, correctionId: values[0] };
  }
  return { action, values };
}

function writeLine(output, value = "") {
  output.write(`${sanitizeTerminalText(value)}\n`);
}

function formatCorrections(value) {
  const lines = [
    "# Listener corrections",
    "",
    `- Active: ${value.active}`,
    `- Shown: ${value.corrections.length}`,
    "- Listening history changed: no",
  ];
  if (value.corrections.length === 0) {
    lines.push("", "No listener corrections match this view.");
    return lines.join("\n");
  }
  lines.push("", "## Corrections", "");
  for (const item of value.corrections) {
    const target = item.artist_credit
      ? `${item.label} - ${item.artist_credit}`
      : item.label;
    lines.push(
      `- [${item.state}] ${item.stance} ${item.entity_type}: ${target}`,
      `  ID: ${item.correction_id}`,
      `  Asserted: ${item.occurred_at}`,
    );
    if (item.note) lines.push(`  Note: ${item.note}`);
  }
  return lines.join("\n");
}

function formatCorrection(value, commandPrefix) {
  const target = value.artist_credit
    ? `${value.label} - ${value.artist_credit}`
    : value.label;
  return [
    "Recorded an explicit listener correction.",
    `Correction: ${value.correction_id}`,
    `Target: ${value.entity_type} - ${target}`,
    `Stance: ${value.stance}`,
    ...(value.superseded_correction_id
      ? [`Superseded: ${value.superseded_correction_id}`]
      : []),
    "Next profile and Tasteprint: updated",
    "Listening history changed: no",
    `Retract with: ${commandPrefix} retract ${value.correction_id}`,
  ].join("\n");
}

function formatRetraction(value) {
  return [
    "Retracted the active listener correction.",
    `Correction: ${value.correction_id}`,
    `Retraction: ${value.retraction_id}`,
    `Target: ${value.entity_type} - ${value.label}`,
    "Next profile and Tasteprint: updated",
    "Listening history changed: no",
  ].join("\n");
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function runProfileCommand({
  args,
  json = false,
  environment = process.env,
  resolvePreferredSubjectId = async () => null,
  output = process.stdout,
  openStore = openListeningHistoryStore,
  now = () => new Date(),
  commandPrefix = "moondog profile",
} = {}) {
  const options = parseProfileArguments(args ?? []);
  if (!options.action || options.action === "help") {
    if (options.values?.length > 0 || json) {
      throw new Error("Usage: moondog profile help.");
    }
    writeLine(output, profileCorrectionHelpText(commandPrefix));
    return;
  }
  if (!new Set(["corrections", "correct", "retract"]).has(options.action)) {
    throw new Error(`Unknown profile command: ${options.action}`);
  }

  const databasePath = resolveListeningHistoryPath(environment);
  const databasePresent = await pathExists(databasePath);
  let preferredSubjectId = null;
  if (options.action === "corrections" && !databasePresent) {
    const empty = {
      subject_id: null,
      active: 0,
      include_inactive: options.includeInactive,
      corrections: [],
      writes: "none",
    };
    writeLine(output, json ? JSON.stringify(empty, null, 2) : formatCorrections(empty));
    return empty;
  }
  if (options.action === "retract" && !databasePresent) {
    throw new Error("No local listener corrections are available to retract.");
  }
  if (
    options.action === "correct" &&
    !databasePresent
  ) {
    preferredSubjectId = await resolvePreferredSubjectId();
    if (!preferredSubjectId) {
      throw new Error(
        "No local music identity is available. Import Apple or Spotify music data before recording a profile correction.",
      );
    }
  }

  const store = await openStore({ environment });
  try {
    let subjectId = store.localSubjectId();
    if (options.action === "corrections" && !subjectId) {
      const empty = {
        subject_id: null,
        active: 0,
        include_inactive: options.includeInactive,
        corrections: [],
        writes: "none",
      };
      writeLine(
        output,
        json ? JSON.stringify(empty, null, 2) : formatCorrections(empty),
      );
      return empty;
    }
    if (options.action === "correct" && !subjectId) {
      preferredSubjectId ??= await resolvePreferredSubjectId();
      if (preferredSubjectId) {
        subjectId = store.localSubjectId({ preferredSubjectId });
      }
    }
    if (!subjectId) {
      throw new Error(
        "No local music identity is available. Import Apple or Spotify music data before recording a profile correction.",
      );
    }
    let value;
    if (options.action === "corrections") {
      const corrections = store.listListenerCorrections({
        subjectId,
        includeInactive: options.includeInactive,
      });
      value = {
        subject_id: subjectId,
        active: store.subjectDataStatus({ subjectId }).active_taste_assertions,
        include_inactive: options.includeInactive,
        corrections,
        writes: "none",
      };
    } else if (options.action === "correct") {
      const timestamp = now().toISOString();
      value = store.recordListenerCorrection({
        subjectId,
        entityType: options.entityType,
        label: options.label,
        artistCredit: options.artistCredit,
        stance: options.stance,
        note: options.note,
        occurredAt: timestamp,
        recordedAt: timestamp,
      });
    } else {
      const timestamp = now().toISOString();
      value = store.retractListenerCorrection({
        subjectId,
        correctionId: options.correctionId,
        occurredAt: timestamp,
        recordedAt: timestamp,
      });
    }
    writeLine(
      output,
      json
        ? JSON.stringify(value, null, 2)
        : options.action === "corrections"
          ? formatCorrections(value)
          : options.action === "correct"
            ? formatCorrection(value, commandPrefix)
            : formatRetraction(value),
    );
    return value;
  } finally {
    store.close();
  }
}
