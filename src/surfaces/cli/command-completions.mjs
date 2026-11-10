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
const serviceChoices = choices([
  ["spotify", N_("Whole songs on your Spotify devices")],
  ["apple_music", N_("30-second previews, played here")],
  ["netease", N_("Whole songs through ncm-cli")],
]);
const generationChoices = choices([["on", N_("Make music on this Mac with Stable Audio 3")], ["off", N_("Stop making music here")]]);
const generationSetupChoices = choices([
  ["download", N_("Download a Stable Audio 3 model from Stability AI")],
  ["use", N_("Make music with a downloaded model")],
  ["remove", N_("Delete a downloaded model from this Mac")],
  ["cancel", N_("Stop the download")],
]);
const sa3ModelChoices = choices([["medium", N_("Medium: best sound, about 5.2 GB")], ["small", N_("Small Music: faster, lighter, about 1.7 GB")]]);
const webChoices = choices([
  ["search", N_("Search public music sites")],
  ["read", N_("Read a public page")],
  ["status", N_("Check whether web lookups work")],
  ["help", N_("Web lookup commands")],
]);
// The picker's own words. The scale matches EFFORT_SCALE; the test holds them together.
const effortChoices = choices([
  ["default", N_("Moondog's default: thinking off where the model allows it")],
  ["off", N_("No extra thinking")],
  ["low", N_("Quick answers")],
  ["medium", N_("Between speed and depth")],
  ["high", N_("Thinks more before answering")],
  ["xhigh", N_("Thinks longer; slower and costs more")],
  ["max", N_("Thinks the most; slowest and costs the most")],
]);
const libraryChoices = choices([
  ["play", N_("Play a playlist by name")],
  ["save", N_("Keep the song playing now")],
  ["import", N_("Copy a playlist from a link")],
  ["export", N_("Send a playlist to Spotify")],
]);
const modelRoleChoices = choices([
  ["roles", N_("See what side tasks use")],
  ["vision", N_("Choose the model that reads images")],
  ["web", N_("Choose the web search service")],
]);
const visionAutoChoices = choices([["auto", N_("Let the chat model read images when it can")]]);
const webServiceChoices = choices([
  ["auto", N_("Take the first service that is set up")],
  ["deepseek", N_("Search with DeepSeek")],
  ["brave", N_("Search with Brave Search")],
  ["codex", N_("Search with the Codex CLI")],
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
  generationSetup = false,
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
    service: { argumentHint: "[spotify|apple_music|netease]", choices: firstArgument(serviceChoices) },
    library: { argumentHint: "[play <name> | save [playlist] | import <link>]", choices: firstArgument(libraryChoices) },
    effort: { argumentHint: "[default|off|low|medium|high|xhigh|max]", choices: firstArgument(effortChoices) },
    // With the core's setup, /generation also downloads, uses and removes Moondog's own models.
    generation: generationSetup ? {
      argumentHint: "[on [folder]|off|download|use|remove|cancel]",
      choices: (previous) => previous.length === 0 ? [...generationChoices, ...generationSetupChoices]
        : previous.length === 1 && ["download", "use", "remove"].includes(previous[0]) ? sa3ModelChoices : [],
    } : { argumentHint: "[on [folder]|off]", choices: firstArgument(generationChoices) },
    lyrics: { argumentHint: "[sync]", choices: firstArgument(choices([["sync", N_("Check profile songs for lyrics")]])) },
    web: { argumentHint: "search <query> | read <url> | status", choices: firstArgument(webChoices) },
    spotify: {
      argumentHint: "<command> [arguments]",
      choices: (previous) => previous.length === 0 ? spotifyChoices
        : previous.length === 1 ? spotifyArguments.get(previous[0]) ?? [] : [],
    },
    endpoint: {
      argumentHint: "[add | remove <id>]",
      choices: (previous) => previous.length === 0
        ? choices([["add", N_("Add an endpoint by its address")], ["remove", N_("Remove an endpoint and its key")]])
        : previous.length === 1 && previous[0] === "remove"
          ? providers().filter((provider) => provider.id.startsWith("endpoint-")).map((provider) => ({ value: provider.id, label: provider.id, description: provider.name }))
          : [],
    },
    auth: {
      argumentHint: "[provider]",
      choices: (previous) => previous.length === 0 ? providers()
        .filter((provider) => authProviderIds.includes(provider.id))
        .map((provider) => ({ value: provider.id, label: provider.id, description: provider.name })) : [],
    },
    model: {
      argumentHint: "[provider] [model] | refresh [provider] | roles | vision auto|<provider> <model> | web auto|deepseek|brave|codex",
      choices: (previous) => {
        const available = providers().filter((provider) => provider.modelCount > 0);
        const asChoice = (provider) => ({ value: provider.id, label: provider.id, description: provider.name });
        const subcommand = previous[0]?.toLowerCase();
        if (subcommand === "roles") return [];
        if (subcommand === "web") return previous.length === 1 ? webServiceChoices : [];
        if (subcommand === "vision") {
          if (previous.length === 1) return [...visionAutoChoices, ...available.map(asChoice)];
          const provider = previous[1].toLowerCase();
          return previous.length === 2 && available.some((item) => item.id === provider)
            ? models(provider).map((model) => ({ value: model.id, label: model.id, description: model.name })) : [];
        }
        if (previous.length > 1) return [];
        if (previous.length === 0) {
          return [{ value: "refresh", label: "refresh", description: translate("Refresh public model metadata; keep selection") },
            ...modelRoleChoices, ...available.map(asChoice)];
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
