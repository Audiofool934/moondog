import { createModelSettings } from "../../runtime/pi/model-settings.mjs";
import { checkInvite, readInvite } from "../../runtime/pi/moondog-model.mjs";
import { sanitizeTerminalText } from "./format-output.mjs";

// The invite code for Moondog's own model, from the terminal, as Settings › Model takes it in the
// window. The code is the key to the model named Moondog; the gateway checks it before it is saved.
export function inviteHelpText() {
  return `# Moondog invite code

- \`moondog invite\` - show whether a code is saved, and today's allowance
- \`moondog invite <code or invite link>\` - check the code and save it
- \`moondog invite remove\` - forget the saved code

With a code, the model named Moondog answers without a key of your own.
If no other model was set up, it becomes the default.`;
}

const millions = (tokens) => `${(tokens / 1e6).toFixed(tokens >= 1e7 ? 0 : 1)}M`;

/** What a saved code allows today, in one line. */
export function describeAllowance({ dailyTokens, usedToday }) {
  if (dailyTokens === null || usedToday === null) return "";
  return `Today: ${millions(usedToday)} of ${millions(dailyTokens)} tokens used. The day turns at midnight, Beijing time.`;
}

/**
 * Returns { action, saved, becameDefault?, label?, dailyTokens?, usedToday? }. It never returns or
 * prints the code.
 */
export async function runInviteCommand({
  args = [],
  json = false,
  environment = process.env,
  output = process.stdout,
  settings = createModelSettings({ environment }),
} = {}) {
  const say = (value) => { if (!json) output.write(`${sanitizeTerminalText(value)}\n`); };
  const finish = (result) => { if (json) output.write(`${JSON.stringify(result)}\n`); return result; };
  const first = args[0]?.toLowerCase();
  if (first === "help" || first === "--help") {
    say(inviteHelpText());
    return { action: "help" };
  }
  if (args.length > 1) throw new Error("Use moondog invite, moondog invite <code>, or moondog invite remove.");
  if (first === "remove") {
    const had = (await readInvite(environment).catch(() => true)) !== null;
    await settings.removeInvite();
    say(had ? "Removed the invite code." : "No invite code was saved.");
    return finish({ action: "remove", saved: false, removed: had });
  }
  if (!first) {
    const invite = await readInvite(environment);
    if (!invite) {
      say("No invite code is saved. Add one with moondog invite <code>.");
      return finish({ action: "status", saved: false });
    }
    const allowance = await checkInvite(invite.code, environment);
    say(["An invite code is saved. The model named Moondog can answer.", describeAllowance(allowance)].filter(Boolean).join("\n"));
    return finish({ action: "status", saved: true, ...allowance });
  }
  const saved = await settings.saveInvite(args[0]);
  say([saved.becameDefault ? "Saved. Moondog's own model is now your default." : "Saved. Pick it with /model moondog/moondog.",
    describeAllowance(saved)].filter(Boolean).join("\n"));
  return finish({ action: "save", saved: true, ...saved });
}
