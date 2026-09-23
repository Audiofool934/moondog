import { access } from "node:fs/promises";

import {
  openListeningHistoryStore,
  resolveListeningHistoryPath,
} from "../../profile/listening-history-store.mjs";
import { sanitizeTerminalText } from "./format-output.mjs";

export function profileCorrectionHelpText(commandPrefix = "moondog profile") {
  return `# Telling Moondog what it got wrong

Commands:

- \`${commandPrefix} corrections [--all] [--json]\` - everything you've told me; add --all to include earlier choices
- \`${commandPrefix} correct --artist <name> (--like|--avoid) [--note <text>] [--json]\` - like an artist, or keep them out
- \`${commandPrefix} correct --track <title> --by <artist> (--like|--avoid) [--note <text>] [--json]\` - like a track, or keep it out
- \`${commandPrefix} retract <correction-id> [--json]\` - undo one of your choices

What you tell me counts for more than what your play counts suggest.
Your listening history stays exactly as it was.
You can see, change, or undo any choice at any time, and they stay on this machine.`;
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
      throw new Error("Tell me one thing to change: --artist or --track.");
    }
    if (track && !by) {
      throw new Error("Add --by <artist> so I know which track you mean.");
    }
    if (artist && by) {
      throw new Error("--by only goes with --track.");
    }
    if (like === avoid) {
      throw new Error("Choose one: --like or --avoid.");
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
    "# What you've told me",
    "",
    `${value.active} ${value.active === 1 ? "choice" : "choices"} in effect.`,
  ];
  if (value.corrections.length === 0) {
    lines.push("", "Nothing yet. Open a song or artist in /taste to like it or keep it out.");
    return lines.join("\n");
  }
  lines.push("");
  for (const item of value.corrections) {
    const target = item.artist_credit
      ? `${item.label} - ${item.artist_credit}`
      : item.label;
    lines.push(
      `- ${item.stance === "avoid" ? "Keep out" : "Like"} ${item.entity_type}: ${target}${item.state === "active" ? "" : ` (${item.state})`}`,
      `  ${String(item.occurred_at).slice(0, 10)} · \`${item.correction_id}\``,
    );
    if (item.note) lines.push(`  "${item.note}"`);
  }
  return lines.join("\n");
}

function formatCorrection(value, commandPrefix) {
  const target = value.artist_credit
    ? `${value.label} - ${value.artist_credit}`
    : value.label;
  return [
    value.stance === "avoid" ? `Noted. I'll keep ${target} out.` : `Noted. You like ${target}.`,
    ...(value.superseded_correction_id ? ["This replaces what you told me before about it."] : []),
    "Your profile is updated. Your listening history stays as it was.",
    `To undo it: ${commandPrefix} retract ${value.correction_id}`,
  ].join("\n");
}

function formatRetraction(value) {
  return [
    `Undone. I'll read ${value.label} from your listening again.`,
    "Your profile is updated. Your listening history stays as it was.",
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
    throw new Error("There's nothing to undo yet.");
  }
  if (
    options.action === "correct" &&
    !databasePresent
  ) {
    preferredSubjectId = await resolvePreferredSubjectId();
    if (!preferredSubjectId) {
      throw new Error(
        "There's no profile to change yet. Bring in your music with /import first.",
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
        "There's no profile to change yet. Bring in your music with /import first.",
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
