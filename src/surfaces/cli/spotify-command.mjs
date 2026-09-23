import {
  SPOTIFY_DEFAULT_REDIRECT_URI,
  SPOTIFY_DEFAULT_SCOPES,
  createSpotifyAuthentication,
} from "../../integrations/spotify/authentication.mjs";
import { createSpotifyCredentialStore } from "../../integrations/spotify/credential-store.mjs";
import {
  readSpotifyConfiguration,
  writeSpotifyConfiguration,
} from "../../integrations/spotify/settings.mjs";
import { createSpotifyService } from "../../integrations/spotify/service.mjs";
import { createSpotifyWebApiClient } from "../../integrations/spotify/web-api-client.mjs";
import { createSpotifyCatalogResolver } from "../../integrations/spotify/catalog-resolver.mjs";
import {
  SPOTIFY_RECENT_ACTIVITY_SOURCE,
  projectSpotifyRecentActivity,
} from "../../integrations/spotify/recent-activity.mjs";
import { readSpotifyHistoryArchive } from "../../integrations/spotify/history-archive.mjs";
import { sanitizeTerminalText } from "./format-output.mjs";

const readCommands = new Set(["account", "now", "devices", "queue", "recent"]);
const writeCommands = new Set([
  "play",
  "pause",
  "next",
  "previous",
  "volume",
  "seek",
  "shuffle",
  "repeat",
  "transfer",
  "queue-add",
]);

export function spotifyHelpText() {
  return `# Moondog Spotify

One-time setup:

1. Create a Spotify developer app.
2. Add this exact redirect URI: \`${SPOTIFY_DEFAULT_REDIRECT_URI}\`.
3. Run \`moondog spotify configure <client-id>\`.
4. Run \`moondog spotify login\`.

Commands:

- \`moondog spotify login [client-id] [--history-only]\`
- \`moondog spotify status [--json]\`
- \`moondog spotify logout [--json]\`
- \`moondog spotify account|now|devices|queue [--json]\`
- \`moondog spotify recent [--limit <1-50>] [--after <ms>|--before <ms>] [--json]\`
- \`moondog spotify sync-recent [--limit <1-50>] [--json]\`
- \`moondog spotify import-history <spotify-history.zip> [--json]\`
- \`moondog spotify play [spotify-uri] [--json]\`
- \`moondog spotify pause|next|previous [--json]\`
- \`moondog spotify volume <0-100> [--json]\`
- \`moondog spotify seek <milliseconds> [--json]\`
- \`moondog spotify shuffle on|off [--json]\`
- \`moondog spotify repeat off|track|context [--json]\`
- \`moondog spotify transfer <device-id> [--play] [--json]\`
- \`moondog spotify queue-add <track-or-episode-uri> [device-id] [--json]\`
- \`moondog spotify resolve --title <title> --artist <artist> [--release <release>] [--duration-ms <ms>] [--json]\`

Playback control requires Spotify Premium and an available Spotify Connect device.`;
}

function writeLine(stream, value = "") {
  stream.write(`${sanitizeTerminalText(value)}\n`);
}

function commandError(message) {
  const error = new Error(message);
  error.code = "spotify_command_invalid";
  return error;
}

function parseArguments(args, inheritedJson) {
  const values = [...(args ?? [])];
  const jsonIndexes = values
    .map((value, index) => (value === "--json" ? index : -1))
    .filter((index) => index !== -1);
  if (jsonIndexes.length > 1 || (jsonIndexes.length === 1 && jsonIndexes[0] !== values.length - 1)) {
    throw commandError("The --json option must appear once at the end of the Spotify command.");
  }
  const json = Boolean(inheritedJson || jsonIndexes.length === 1);
  if (jsonIndexes.length === 1) values.pop();
  const action = values[0];
  const rest = values.slice(1);
  if (action === "-h" || action === "--help") return { action: "help", rest, json };
  return { action, rest, json };
}

function exactArguments(action, rest, count, usage) {
  if (rest.length !== count) {
    throw commandError(`Usage: moondog spotify ${usage ?? action}.`);
  }
}

function integerArgument(value, { label, minimum = 0, maximum }) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw commandError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw commandError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

function parseResolveFlags(action, rest) {
  const flags = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag !== "--title" && flag !== "--artist" && flag !== "--release" && flag !== "--duration-ms") {
      throw commandError(
        "Usage: moondog spotify resolve --title <title> --artist <artist> [--release <release>] [--duration-ms <milliseconds>].",
      );
    }
    if (typeof value !== "string" || !value.trim()) {
      throw commandError(`The ${flag} option requires a value.`);
    }
    if (flags[flag] !== undefined) {
      throw commandError(`The ${flag} option must appear once.`);
    }
    flags[flag] = value;
  }
  if (!flags["--title"] || !flags["--artist"]) {
    throw commandError(
      "Usage: moondog spotify resolve --title <title> --artist <artist> [--release <release>] [--duration-ms <milliseconds>].",
    );
  }
  return {
    title: flags["--title"],
    artist: flags["--artist"],
    release: flags["--release"] ?? "Unknown release",
    ...(flags["--duration-ms"] !== undefined
      ? {
          durationMs: integerArgument(flags["--duration-ms"], {
            label: "--duration-ms",
            maximum: 86_400_000,
          }),
        }
      : {}),
  };
}

function parseRecentFlags(action, rest, { cursors = true } = {}) {
  if (rest.length % 2 !== 0) {
    throw commandError(
      `Usage: moondog spotify ${action} [--limit <1-50>]${cursors ? " [--after <ms>|--before <ms>]" : ""}.`,
    );
  }
  const input = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    const allowed = cursors
      ? new Set(["--limit", "--after", "--before"])
      : new Set(["--limit"]);
    if (!allowed.has(flag) || input[flag] !== undefined) {
      throw commandError(
        `Usage: moondog spotify ${action} [--limit <1-50>]${cursors ? " [--after <ms>|--before <ms>]" : ""}.`,
      );
    }
    input[flag] = integerArgument(value, {
      label: flag,
      minimum: flag === "--limit" ? 1 : 0,
      maximum: flag === "--limit" ? 50 : Number.MAX_SAFE_INTEGER,
    });
  }
  if (input["--after"] !== undefined && input["--before"] !== undefined) {
    throw commandError("Choose either --after or --before for Spotify recent activity.");
  }
  return {
    ...(input["--limit"] !== undefined ? { limit: input["--limit"] } : {}),
    ...(input["--after"] !== undefined ? { after: input["--after"] } : {}),
    ...(input["--before"] !== undefined ? { before: input["--before"] } : {}),
  };
}

function publicAuthStatus(status, clientIdConfigured, requiredScopes = SPOTIFY_DEFAULT_SCOPES) {
  const stored = status?.state === "stored";
  const result = {
    provider: "spotify",
    state: stored ? "stored" : "not_configured",
    client_id_configured: clientIdConfigured,
    type: stored && status?.type === "oauth" ? "oauth" : null,
    access_expires_at:
      stored && Number.isSafeInteger(status?.accessExpiresAt)
        ? status.accessExpiresAt
        : null,
    refresh_expires_at:
      stored && Number.isSafeInteger(status?.refreshExpiresAt)
        ? status.refreshExpiresAt
        : null,
    redirect_uri: SPOTIFY_DEFAULT_REDIRECT_URI,
  };
  if (stored) {
    const grantedScopes =
      typeof status?.scopes === "string"
        ? status.scopes.split(/\s+/u).filter(Boolean).sort()
        : [];
    const missingScopes = requiredScopes.filter(
      (scope) => !grantedScopes.includes(scope),
    );
    result.scopes_sufficient = missingScopes.length === 0;
    result.missing_scopes = missingScopes;
  }
  return result;
}

function actionResult(receipt, fallbackAction) {
  return {
    provider: "spotify",
    ok: receipt?.ok === true,
    effect: "write_external",
    action:
      typeof receipt?.action === "string" && receipt.action.length > 0
        ? receipt.action
        : fallbackAction,
    state: receipt?.state === "accepted" ? "accepted" : "unknown",
  };
}

function withoutSecretFields(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map((entry) => withoutSecretFields(entry, seen));
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return null;
  seen.add(value);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/(?:authorization|credential|secret|token)/iu.test(key)) continue;
    result[key] = withoutSecretFields(entry, seen);
  }
  return result;
}

function itemLabel(item) {
  if (!item || typeof item !== "object") return "Unknown item";
  const name = typeof item.name === "string" ? item.name : "Unknown item";
  const artists = Array.isArray(item.artists) ? item.artists.filter((value) => typeof value === "string") : [];
  return artists.length > 0 ? `${name} - ${artists.join(", ")}` : name;
}

function formatPlain(action, value) {
  const plays = (count) => `${count ?? 0} ${count === 1 ? "play" : "plays"}`;
  const day = (timestamp) => typeof timestamp === "string" ? timestamp.slice(0, 10) : "an unknown date";
  if (action === "configure") {
    return [
      "Spotify app saved.",
      `Redirect URI: ${SPOTIFY_DEFAULT_REDIRECT_URI}`,
      "Next: moondog spotify login",
    ].join("\n");
  }
  if (["status", "login", "logout"].includes(action)) {
    const lines = [
      `Spotify app: ${value.client_id_configured ? "saved" : "not set up yet"}`,
      `Signed in: ${value.state === "stored" ? "yes" : "no"}`,
      `Redirect URI: ${SPOTIFY_DEFAULT_REDIRECT_URI}`,
    ];
    if (value.state === "stored") {
      const purpose = value.scope_purpose === "recent_listening" ? "reading recent plays" : "playback and playlists";
      lines.push(
        value.scopes_sufficient
          ? `Permissions for ${purpose}: all set`
          : `Permissions for ${purpose}: sign in again to allow ${value.missing_scopes.join(", ")}`,
      );
    }
    return lines.join("\n");
  }
  if (action === "resolve") {
    const resolutions = Array.isArray(value.resolutions)
      ? value.resolutions
      : [];
    const lines = [
      `Found ${value.resolved_count ?? 0} of ${value.requested ?? resolutions.length} on Spotify`,
    ];
    for (const resolution of resolutions) {
      if (resolution.status !== "resolved") {
        lines.push(`- ${resolution.track_ref_id}: not on Spotify`);
        continue;
      }
      const artists = Array.isArray(resolution.matched?.artists)
        ? resolution.matched.artists.join(", ")
        : "Unknown artist";
      lines.push(
        `- ${resolution.track_ref_id}: ${resolution.matched?.title ?? "Unknown track"} - ${artists} (${resolution.match_quality ?? "standard"} match)`,
      );
    }
    return lines.join("\n");
  }
  if (writeCommands.has(action)) {
    return `Spotify: ${value.action}, done.`;
  }
  if (action === "account") {
    const lines = ["# Your Spotify account"];
    if (value.display_name) lines.push(`- Name: ${value.display_name}`);
    if (value.account_id) lines.push(`- ID: ${value.account_id}`);
    if (value.product) lines.push(`- Plan: ${value.product}`);
    if (value.country) lines.push(`- Country: ${value.country}`);
    return lines.join("\n");
  }
  if (action === "now") {
    if (value.state !== "available") return "Nothing is playing on Spotify.";
    const lines = [
      `${value.is_playing ? "Playing" : "Paused"}: ${itemLabel(value.item)}`,
    ];
    if (value.device?.name) lines.push(`On: ${value.device.name} (${value.device.id})`);
    if (Number.isInteger(value.progress_ms)) {
      const seconds = Math.floor(value.progress_ms / 1000);
      lines.push(`At: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
    }
    return lines.join("\n");
  }
  if (action === "devices") {
    const devices = Array.isArray(value.devices) ? value.devices : [];
    if (devices.length === 0) return "No Spotify devices are available. Open Spotify somewhere first.";
    return [
      "# Your Spotify devices",
      ...devices.map(
        (device) =>
          `- ${device.is_active ? "*" : "-"} ${device.name} (${device.type}) - ${device.id}`,
      ),
    ].join("\n");
  }
  if (action === "queue") {
    const queue = Array.isArray(value.queue) ? value.queue : [];
    const lines = ["# Up next on Spotify"];
    if (value.currently_playing) lines.push(`Now: ${itemLabel(value.currently_playing)}`);
    if (queue.length === 0) lines.push("Nothing queued.");
    else lines.push(...queue.map((item, index) => `${index + 1}. ${itemLabel(item)}`));
    return lines.join("\n");
  }
  if (action === "recent") {
    const items = Array.isArray(value.items) ? value.items : [];
    if (items.length === 0) return "Spotify didn't return any recent plays.";
    return [
      `# What you played lately (${items.length})`,
      ...items.map(
        (item) =>
          `- ${item.played_at}: ${itemLabel(item.track)}${item.context_type ? ` [${item.context_type}]` : ""}`,
      ),
    ].join("\n");
  }
  if (action === "sync-recent") {
    return [
      "# Your latest plays are in",
      `- ${plays(value.fetched_events)} from Spotify`,
      `- ${value.inserted_events ?? 0} new, ${value.duplicate_events ?? 0} I already had`,
      `- ${value.inserted_track_refs ?? 0} songs new to your profile`,
    ].join("\n");
  }
  if (action === "import-history") {
    const extended =
      value.data_scope === "lifetime_extended_streaming_history";
    const lines = [
      extended ? "# Your Spotify history is in" : "# Your Spotify account data is in",
      `- ${plays(value.input_records)} in the file, from ${day(value.earliest_occurred_at)} to ${day(value.latest_occurred_at)}`,
      value.already_imported
        ? "- You imported this file before, so nothing new was added"
        : `- ${value.inserted_events ?? 0} new${value.duplicate_events ? `, ${value.duplicate_events} I already had` : ""}`,
    ];
    if (value.superseded_events > 0) {
      lines.push(`- ${plays(value.superseded_events)} you already had were replaced with more detailed versions`);
    }
    if (value.inserted_track_refs > 0) lines.push(`- ${value.inserted_track_refs} songs new to your profile`);
    if (!extended && value.inserted_profile_evidence > 0) {
      lines.push(`- ${value.inserted_profile_evidence} saved songs, follows, and playlist entries`);
    }
    if (!extended) lines.push("- This format doesn't include listening time. Extended streaming history does.");
    lines.push(`- File fingerprint: ${value.archive_sha256 ?? "unavailable"}`);
    return lines.join("\n");
  }
  return JSON.stringify(value, null, 2);
}

function emit(output, action, value, json) {
  const safeValue = withoutSecretFields(value);
  writeLine(output, json ? JSON.stringify(safeValue, null, 2) : formatPlain(action, safeValue));
}

function knownSpotifyError(error) {
  return (
    typeof error?.code === "string" &&
    (error.code.startsWith("spotify_") || error.code.startsWith("invalid_"))
  );
}

async function externalCall(operation, safeFailureMessage) {
  try {
    return await operation();
  } catch (error) {
    if (knownSpotifyError(error)) throw error;
    const wrapped = new Error(safeFailureMessage);
    wrapped.code = "spotify_command_failed";
    throw wrapped;
  }
}

function createRuntimeResolver({
  environment,
  fetchImpl,
  openBrowser,
  credentialStore,
  spotify,
  historyOnly = false,
}) {
  let scopedStore;
  let configuration;
  let authentication;
  let client;
  let service;

  const resolveStore = () => {
    if (!scopedStore) {
      scopedStore = credentialStore ?? createSpotifyCredentialStore({ environment });
    }
    return scopedStore;
  };

  const readConfiguration = async () => {
    if (configuration !== undefined) return configuration;
    if (spotify && Object.hasOwn(spotify, "configuration")) {
      configuration =
        typeof spotify.configuration === "function"
          ? await spotify.configuration()
          : spotify.configuration;
    } else {
      configuration = await readSpotifyConfiguration(environment);
    }
    return configuration;
  };

  return {
    async configure(clientId) {
      const value = spotify?.configure
        ? await spotify.configure(clientId)
        : await writeSpotifyConfiguration(clientId, environment);
      configuration = value;
      return value;
    },

    async configuration() {
      return readConfiguration();
    },

    async authentication({ required = true } = {}) {
      if (authentication) return authentication;
      if (spotify?.authentication) {
        authentication = spotify.authentication;
        return authentication;
      }
      const current = await readConfiguration();
      if (!current) {
        if (!required) return undefined;
        throw commandError(
          "Spotify is not configured. Run moondog spotify configure <client-id> first.",
        );
      }
      authentication = createSpotifyAuthentication({
        clientId: current.clientId,
        ...(historyOnly ? { scopes: ["user-read-recently-played"] } : {}),
        credentialStore: resolveStore(),
        fetchImpl,
        ...(openBrowser ? { openBrowser } : {}),
      });
      return authentication;
    },

    async webClient() {
      if (client) return client;
      if (spotify?.service) {
        throw commandError(
          "The catalog resolver is unavailable in this embedded Spotify runtime.",
        );
      }
      const auth = await this.authentication();
      client = createSpotifyWebApiClient({
        fetchImpl,
        tokenProvider: () => auth.getAccessToken(),
      });
      return client;
    },

    async resolver(resolutionCache) {
      if (spotify?.resolver) return spotify.resolver;
      return createSpotifyCatalogResolver({
        client: await this.webClient(),
        ...(resolutionCache ? { cache: resolutionCache } : {}),
      });
    },

    async service() {
      if (service) return service;
      if (spotify?.service) {
        service = spotify.service;
        return service;
      }
      service = createSpotifyService({ client: await this.webClient() });
      return service;
    },

    async deleteCredentialWithoutConfiguration() {
      await resolveStore().delete();
    },
  };
}

async function runReadCommand(action, service, input) {
  if (action === "account") return service.account();
  if (action === "now") return service.currentPlayer();
  if (action === "devices") return service.devices();
  if (action === "recent") return service.recentActivity(input);
  return service.queue();
}

async function runWriteCommand(action, rest, service) {
  if (["pause", "next", "previous"].includes(action)) {
    exactArguments(action, rest, 0);
    return actionResult(await service[action](), `playback.${action}`);
  }
  if (action === "play") {
    if (rest.length > 1) throw commandError("Usage: moondog spotify play [spotify-uri].");
    const input = rest[0] ? { uris: [rest[0]] } : undefined;
    return actionResult(await service.resume(input), "playback.resume");
  }
  if (action === "volume") {
    exactArguments(action, rest, 1, "volume <0-100>");
    const percent = integerArgument(rest[0], {
      label: "Spotify volume",
      maximum: 100,
    });
    return actionResult(await service.setVolume({ percent }), "playback.volume.set");
  }
  if (action === "seek") {
    exactArguments(action, rest, 1, "seek <milliseconds>");
    const positionMs = integerArgument(rest[0], {
      label: "Spotify seek position",
      maximum: 86_400_000,
    });
    return actionResult(await service.seek({ positionMs }), "playback.seek");
  }
  if (action === "shuffle") {
    exactArguments(action, rest, 1, "shuffle on|off");
    if (!new Set(["on", "off"]).has(rest[0])) {
      throw commandError("Spotify shuffle state must be on or off.");
    }
    return actionResult(
      await service.setShuffle({ state: rest[0] === "on" }),
      "playback.shuffle.set",
    );
  }
  if (action === "repeat") {
    exactArguments(action, rest, 1, "repeat off|track|context");
    if (!new Set(["off", "track", "context"]).has(rest[0])) {
      throw commandError("Spotify repeat state must be off, track, or context.");
    }
    return actionResult(
      await service.setRepeat({ state: rest[0] }),
      "playback.repeat.set",
    );
  }
  if (action === "transfer") {
    if (rest.length < 1 || rest.length > 2 || (rest.length === 2 && rest[1] !== "--play")) {
      throw commandError("Usage: moondog spotify transfer <device-id> [--play].");
    }
    return actionResult(
      await service.transfer({ deviceId: rest[0], play: rest[1] === "--play" }),
      "playback.transfer",
    );
  }
  if (action === "queue-add") {
    if (rest.length < 1 || rest.length > 2) {
      throw commandError(
        "Usage: moondog spotify queue-add <track-or-episode-uri> [device-id].",
      );
    }
    return actionResult(
      await service.addToQueue({ uri: rest[0], deviceId: rest[1] }),
      "playback.queue.add",
    );
  }
  throw commandError(`Unknown Spotify command: ${action}`);
}

export async function runSpotifyCommand({
  args = [],
  json = false,
  environment = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  fetchImpl = globalThis.fetch,
  openBrowser,
  credentialStore,
  resolutionCache = null,
  recentActivityStore = null,
  subjectId = null,
  now = Date.now,
  historyArchiveImporter = readSpotifyHistoryArchive,
  spotify,
  signalTarget = process,
  signal,
} = {}) {
  const options = parseArguments(args, json);
  const action = options.action;
  if (!action || action === "help") {
    exactArguments("help", options.rest, 0, "help");
    writeLine(stdout, spotifyHelpText());
    return;
  }

  const knownCommands = new Set([
    "configure",
    "login",
    "status",
    "logout",
    "resolve",
    "sync-recent",
    "import-history",
    ...readCommands,
    ...writeCommands,
  ]);
  if (!knownCommands.has(action)) throw commandError(`Unknown Spotify command: ${action}`);

  if (action === "import-history") {
    exactArguments(
      action,
      options.rest,
      1,
      "import-history <spotify-history.zip>",
    );
    if (
      !recentActivityStore ||
      typeof recentActivityStore.ingestImport !== "function"
    ) {
      throw commandError("Spotify account-data history storage is unavailable.");
    }
    if (typeof subjectId !== "string" || !subjectId.trim()) {
      throw commandError(
        "A trusted local music subject is required for account-data history import.",
      );
    }
    const currentTime = now();
    if (!Number.isFinite(currentTime)) {
      throw commandError("Spotify account-data import time is unavailable.");
    }
    const bundle = await externalCall(
      () =>
        historyArchiveImporter({
          archivePath: options.rest[0],
          subjectId,
          capturedAt: new Date(currentTime).toISOString(),
        }),
      "Spotify account-data history could not be read.",
    );
    const result = await externalCall(
      () => recentActivityStore.ingestImport(bundle),
      "Spotify account-data history could not be stored.",
    );
    emit(stdout, action, result, options.json);
    return result;
  }

  const runtime = createRuntimeResolver({
    environment,
    fetchImpl,
    openBrowser,
    credentialStore,
    spotify,
    historyOnly: action === "login" && options.rest.includes("--history-only"),
  });

  if (action === "configure") {
    exactArguments(action, options.rest, 1, "configure <client-id>");
    await externalCall(
      () => runtime.configure(options.rest[0]),
      "Spotify configuration could not be saved.",
    );
    const result = {
      provider: "spotify",
      state: "configured",
      client_id_configured: true,
      redirect_uri: SPOTIFY_DEFAULT_REDIRECT_URI,
    };
    emit(stdout, action, result, options.json);
    return result;
  }

  if (action === "login") {
    const historyOnly = options.rest.includes("--history-only");
    const loginArgs = options.rest.filter((arg) => arg !== "--history-only");
    if (loginArgs.length > 1 || options.rest.length - loginArgs.length > 1 || loginArgs.some((arg) => arg.startsWith("--"))) {
      throw commandError("Usage: moondog spotify login [client-id] [--history-only].");
    }
    if (loginArgs[0]) {
      await externalCall(
        () => runtime.configure(loginArgs[0]),
        "Spotify configuration could not be saved.",
      );
    }
    const authentication = await runtime.authentication();
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", onSigint, { once: true });
    signalTarget.once("SIGINT", onSigint);
    try {
      const status = await externalCall(
        () =>
          authentication.login({
            signal: controller.signal,
            onAuthorizationUrl(url) {
              writeLine(stderr, "Open this URL to authorize Spotify:");
              writeLine(stderr, url);
              writeLine(stderr, `Redirect URI: ${SPOTIFY_DEFAULT_REDIRECT_URI}`);
            },
          }),
        "Spotify login failed before a usable credential was saved.",
      );
      const result = publicAuthStatus(status, true, historyOnly ? ["user-read-recently-played"] : SPOTIFY_DEFAULT_SCOPES);
      if (historyOnly) result.scope_purpose = "recent_listening";
      emit(stdout, action, result, options.json);
      return result;
    } finally {
      signalTarget.removeListener("SIGINT", onSigint);
      signal?.removeEventListener("abort", onSigint);
    }
  }

  if (action === "status") {
    exactArguments(action, options.rest, 0);
    const configuration = await runtime.configuration();
    const authentication = await runtime.authentication({ required: false });
    const status = authentication
      ? await externalCall(
          () => authentication.status(),
          "Spotify authorization status could not be read.",
        )
      : undefined;
    const result = publicAuthStatus(status, Boolean(configuration || spotify?.authentication));
    emit(stdout, action, result, options.json);
    return result;
  }

  if (action === "logout") {
    exactArguments(action, options.rest, 0);
    const configuration = await runtime.configuration();
    const authentication = await runtime.authentication({ required: false });
    let status;
    if (authentication) {
      status = await externalCall(
        () => authentication.logout(),
        "Spotify authorization could not be removed.",
      );
    } else {
      await externalCall(
        () => runtime.deleteCredentialWithoutConfiguration(),
        "Spotify authorization could not be removed.",
      );
    }
    const result = publicAuthStatus(status, Boolean(configuration || spotify?.authentication));
    emit(stdout, action, result, options.json);
    return result;
  }

  if (action === "resolve") {
    const flags = parseResolveFlags(action, options.rest);
    const resolver = await runtime.resolver(resolutionCache);
    const result = await externalCall(
      () =>
        resolver.resolve([
          {
            track_ref_id: "cli",
            title: flags.title,
            artist_credit: flags.artist,
            release: flags.release,
            ...(flags.durationMs !== undefined
              ? { duration_ms: flags.durationMs }
              : {}),
          },
        ]),
      "Spotify catalog resolution failed.",
    );
    emit(stdout, action, result, options.json);
    return result;
  }

  if (readCommands.has(action)) {
    const input =
      action === "recent"
        ? parseRecentFlags(action, options.rest)
        : (exactArguments(action, options.rest, 0), undefined);
    const service = await runtime.service();
    const result = await externalCall(
      () => runReadCommand(action, service, input),
      `Spotify ${action} could not be read.`,
    );
    emit(stdout, action, result, options.json);
    return result;
  }

  if (action === "sync-recent") {
    const input = parseRecentFlags(action, options.rest, { cursors: false });
    if (!recentActivityStore || typeof recentActivityStore.ingest !== "function") {
      throw commandError("Spotify recent activity storage is unavailable.");
    }
    if (typeof subjectId !== "string" || !subjectId.trim()) {
      throw commandError("A trusted local music subject is required for recent activity sync.");
    }
    const cursor = recentActivityStore.sourceCursor(
      SPOTIFY_RECENT_ACTIVITY_SOURCE,
    );
    const service = await runtime.service();
    const page = await externalCall(
      () =>
        service.recentActivity({
          ...input,
          ...(cursor !== null ? { after: cursor } : {}),
        }),
      "Spotify recent activity could not be read.",
    );
    const currentTime = now();
    if (!Number.isFinite(currentTime)) {
      throw commandError("Spotify recent activity capture time is unavailable.");
    }
    const result = await externalCall(
      () =>
        recentActivityStore.ingest(
          projectSpotifyRecentActivity({
            subjectId,
            page,
            capturedAt: new Date(currentTime).toISOString(),
          }),
        ),
      "Spotify recent activity could not be stored.",
    );
    emit(stdout, action, result, options.json);
    return result;
  }

  const service = await runtime.service();
  const result = await externalCall(
    () => runWriteCommand(action, options.rest, service),
    `Spotify ${action} failed.`,
  );
  emit(stdout, action, result, options.json);
  return result;
}
