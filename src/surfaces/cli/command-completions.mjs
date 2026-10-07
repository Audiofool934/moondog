import { N_, screenTranslator } from "../../i18n/index.mjs";

// Descriptions are marked English and translated when shown, so /language applies at once.
let translate = screenTranslator("en");
function choices(entries) {
  return entries.map(([value, description]) => ({ value, label: value, get description() { return translate.marked(description); } }));
}

const themeChoices = choices([
  ["paper", N_("Black ink on white paper")],
  ["charcoal", N_("Moonlight on a black sky")],
  ["terminal", N_("Keep your terminal's colors")],
  ["auto", N_("Follow MOONDOG_THEME, or guess from your terminal")],
]);
const artChoices = choices([
  ["braille", N_("Character artwork with fine detail")],
  ["ascii", N_("Simple terminal characters")],
  ["off", N_("A quiet opening, no artwork")],
  ["auto", N_("Choose artwork for this terminal")],
]);
const motionChoices = choices([["on", N_("Animate the character artwork")], ["off", N_("Keep the artwork still")]]);
const webChoices = choices([
  ["search", N_("Search public music sites")],
  ["read", N_("Read a public page")],
  ["status", N_("Check whether web lookups work")],
  ["help", N_("Web lookup commands")],
]);
const spotifyChoices = choices([
  ["status", N_("Check your Spotify connection")],
  ["now", N_("What's playing now")],
  ["devices", N_("Your Spotify devices")],
  ["queue", N_("What's queued up")],
  ["recent", N_("What you played lately")],
  ["account", N_("Which account is connected")],
  ["play", N_("Resume playback or play a Spotify URI")],
  ["pause", N_("Pause playback")],
  ["next", N_("Play the next track")],
  ["previous", N_("Play the previous track")],
  ["volume", N_("Set volume from 0 to 100")],
  ["seek", N_("Seek to a position in milliseconds")],
  ["shuffle", N_("Set shuffle on or off")],
  ["repeat", N_("Repeat off, one track, or the context")],
  ["transfer", N_("Move playback to another device")],
  ["queue-add", N_("Add a track or episode URI to the queue")],
  ["resolve", N_("Find a track by title and artist")],
  ["sync-recent", N_("Add your latest plays to your profile")],
  ["sync-library", N_("Add your Spotify library and top artists to your profile")],
  ["import-history", N_("Add a Spotify history ZIP to your profile")],
  ["configure", N_("Save your Spotify app's Client ID")],
  ["login", N_("Connect your Spotify account")],
  ["logout", N_("Disconnect your Spotify account")],
  ["help", N_("Spotify commands")],
]);
const spotifyArguments = new Map([
  ["shuffle", choices([["on", N_("Enable shuffle")], ["off", N_("Disable shuffle")]])],
  ["repeat", choices([["off", N_("Disable repeat")], ["track", N_("Repeat this track")], ["context", N_("Repeat the album or playlist")]])],
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
  tr,
} = {}) {
  if (tr) translate = tr;
  const firstArgument = (items) => (previous) => previous.length === 0 ? items : [];
  const specifications = {
    update: {
      argumentHint: "[--check] [--channel latest|beta]",
      choices: previous => previous.at(-1) === "--channel"
        ? choices([["latest", N_("Stable releases")], ["beta", N_("Preview releases")]])
        : choices([["--check", N_("Check without installing")], ["--channel", N_("Choose the release channel")]]).filter(item => !previous.includes(item.value)),
    },
    theme: { argumentHint: "[paper|charcoal|terminal|auto]", choices: firstArgument(themeChoices) },
    art: { argumentHint: "[braille|ascii|off|auto]", choices: firstArgument(artChoices) },
    motion: { argumentHint: "[on|off]", choices: firstArgument(motionChoices) },
    lyrics: { argumentHint: "[sync]", choices: firstArgument(choices([["sync", N_("Check profile songs for lyrics")]])) },
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
      argumentHint: "[provider] [model] | refresh [provider]",
      choices: (previous) => {
        if (previous.length > 1) return [];
        const available = providers().filter((provider) => provider.modelCount > 0);
        if (previous.length === 0) {
          return [{ value: "refresh", label: "refresh", description: translate("Refresh public model metadata; keep selection") },
            ...available.map((provider) => ({ value: provider.id, label: provider.id, description: provider.name }))];
        }
        const providerId = previous[0].toLowerCase();
        if (providerId === "refresh") return available.filter(provider => authProviderIds.includes(provider.id))
          .map(provider => ({ value: provider.id, label: provider.id, description: provider.name }));
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
