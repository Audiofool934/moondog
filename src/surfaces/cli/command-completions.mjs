function choices(entries) {
  return entries.map(([value, description]) => ({ value, label: value, description }));
}

const themeChoices = choices([
  ["paper", "Warm ivory and charcoal ink"],
  ["charcoal", "A quiet room, warm light"],
  ["terminal", "Keep your terminal's colors"],
  ["auto", "Use your environment and terminal hint"],
]);
const artChoices = choices([
  ["braille", "Character artwork with fine detail"],
  ["ascii", "Simple terminal characters"],
  ["off", "A minimal opening"],
  ["auto", "Choose artwork for this terminal"],
]);
const motionChoices = choices([["on", "Animate the character artwork"], ["off", "Keep the artwork still"]]);
const webChoices = choices([
  ["search", "Search public music sources with a query"],
  ["read", "Read a public page by URL"],
  ["status", "Inspect web research readiness"],
  ["help", "Show web research commands"],
]);
const spotifyChoices = choices([
  ["status", "Inspect your Spotify connection"],
  ["now", "Show current playback"],
  ["devices", "List Spotify Connect devices"],
  ["queue", "Inspect the playback queue"],
  ["recent", "Read recently played tracks"],
  ["account", "Inspect the connected account"],
  ["play", "Resume playback or play a Spotify URI"],
  ["pause", "Pause playback"],
  ["next", "Play the next track"],
  ["previous", "Play the previous track"],
  ["volume", "Set volume from 0 to 100"],
  ["seek", "Seek to a position in milliseconds"],
  ["shuffle", "Set shuffle on or off"],
  ["repeat", "Repeat off, one track, or the context"],
  ["transfer", "Transfer playback to a device ID"],
  ["queue-add", "Add a track or episode URI to the queue"],
  ["resolve", "Find a track by title and artist"],
  ["sync-recent", "Import recent activity into your local profile"],
  ["import-history", "Import a saved Spotify history ZIP"],
  ["configure", "Configure a Spotify developer client ID"],
  ["login", "Connect your Spotify account"],
  ["logout", "Disconnect your Spotify account"],
  ["help", "Show Spotify commands"],
]);
const spotifyArguments = new Map([
  ["shuffle", choices([["on", "Enable shuffle"], ["off", "Disable shuffle"]])],
  ["repeat", choices([["off", "Disable repeat"], ["track", "Repeat this track"], ["context", "Repeat the album or playlist"]])],
]);

function completeArgument(prefix, getChoices) {
  // Enum completion leaves quoted, escaped, and multiline input to Pi's editor.
  if (/["'\\\r\n]/u.test(prefix)) return null;
  const [, beforeToken, token] = prefix.match(/^(.*?)(\S*)$/u);
  const previous = beforeToken.trim().split(/\s+/u).filter(Boolean);
  const available = getChoices(previous);
  // A complete value should submit on Enter, even if it also prefixes another choice.
  if (available.some((item) => item.value === token)) return null;
  const matching = available.filter((item) => item.value.toLowerCase().startsWith(token.toLowerCase()));
  // Pi replaces the entire argument prefix, including earlier arguments.
  return matching.length ? matching.map((item) => ({ ...item, value: beforeToken + item.value })) : null;
}

export function withCommandCompletions(commands, {
  providers = () => [],
  models = () => [],
  authProviderIds = [],
} = {}) {
  const firstArgument = (items) => (previous) => previous.length === 0 ? items : [];
  const specifications = {
    theme: { argumentHint: "[paper|charcoal|terminal|auto]", choices: firstArgument(themeChoices) },
    art: { argumentHint: "[braille|ascii|off|auto]", choices: firstArgument(artChoices) },
    motion: { argumentHint: "[on|off]", choices: firstArgument(motionChoices) },
    web: { argumentHint: "search <query> | read <url> | status", choices: firstArgument(webChoices) },
    spotify: {
      argumentHint: "<command> [arguments]",
      choices: (previous) => previous.length === 0 ? spotifyChoices
        : previous.length === 1 ? spotifyArguments.get(previous[0]) ?? [] : [],
    },
    auth: {
      argumentHint: "[provider]",
      choices: (previous) => previous.length === 0 ? providers()
        .filter((provider) => authProviderIds.includes(provider.id))
        .map((provider) => ({ value: provider.id, label: provider.id, description: provider.name })) : [],
    },
    model: {
      argumentHint: "[provider] [model]",
      choices: (previous) => {
        if (previous.length > 1) return [];
        const available = providers().filter((provider) => provider.modelCount > 0);
        if (previous.length === 0) {
          return available.map((provider) => ({ value: provider.id, label: provider.id, description: provider.name }));
        }
        const providerId = previous[0].toLowerCase();
        if (!available.some((provider) => provider.id === providerId)) return [];
        return models(providerId).map((model) => ({ value: model.id, label: model.id, description: model.name }));
      },
    },
  };
  return commands.map((command) => {
    const specification = specifications[command.name];
    if (!specification) return command;
    return {
      ...command,
      argumentHint: command.argumentHint ?? specification.argumentHint,
      getArgumentCompletions: command.getArgumentCompletions ?? ((prefix) => completeArgument(prefix, specification.choices)),
    };
  });
}
