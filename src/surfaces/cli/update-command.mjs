export function parseUpdateArguments(args = []) {
  const result = { checkOnly: false };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--check" && !result.checkOnly) result.checkOnly = true;
    else if (args[index] === "--channel" && !result.channel && ["latest", "beta"].includes(args[index + 1])) result.channel = args[++index];
    else if (["help", "--help", "-h"].includes(args[index]) && args.length === 1) return { help: true };
    else throw new Error("Usage: moondog update [--check] [--channel latest|beta]");
  }
  return result;
}

export function formatUpdateResult(result) {
  if (result.state === "updated") return `Updated Moondog ${result.previous} → ${result.latest} (${result.channel}). Run moondog to start the new version.\nPrevious program: ${result.recoveryBackup}\nYour profile, sign-ins and conversation history were preserved.`;
  if (result.state === "unavailable") return result.message;
  if (result.state === "current") return `Moondog ${result.current} is current or newer than the ${result.channel} release (${result.latest}).`;
  return `Moondog ${result.latest} is available (${result.channel}); installed: ${result.current}.\n${result.releaseUrl}\n${result.compatible ? "Run moondog update, or /update in the listening room." : `Update Node to ${result.minimumNode} or newer first.`}`;
}

export async function runUpdateCommand({ args = [], updater, signal, deferInstall = false, onProgress } = {}) {
  const options = parseUpdateArguments(args);
  if (options.help) return { text: "moondog update [--check] [--channel latest|beta]\n--check only reads release metadata. Updates preserve personal data and require other Moondog sessions to be closed." };
  const result = options.checkOnly || deferInstall
    ? await updater.check({ channel: options.channel, force: true, signal })
    : await updater.apply({ channel: options.channel, signal, onProgress });
  if (options.checkOnly || deferInstall) signal?.throwIfAborted();
  if (deferInstall && !options.checkOnly && result.state === "available" && result.compatible) {
    const install = await updater.installation();
    if (install.mode === "unmanaged") throw new Error("Update this installation using its original installation method.");
    return { text: "Closing this session before installing the update. Your conversation is saved.", update: { channel: result.channel } };
  }
  return { text: formatUpdateResult(result), result };
}
