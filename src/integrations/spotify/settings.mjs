import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveMoondogAuthFile } from "../../runtime/pi/persistent-credential-store.mjs";

const SETTINGS_VERSION = 1;
const clientIdPattern = /^[A-Za-z0-9_-]{8,128}$/u;

function configurationError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "MoondogSpotifySettingsError";
  error.code = "spotify_settings_invalid";
  return error;
}

function normalizeClientId(value) {
  const clientId = typeof value === "string" ? value.trim() : "";
  if (!clientIdPattern.test(clientId)) {
    throw configurationError("Spotify configuration requires a valid client ID.");
  }
  return clientId;
}

export function resolveSpotifySettingsFile(environment = process.env) {
  return path.join(
    path.dirname(resolveMoondogAuthFile(environment)),
    "spotify.json",
  );
}

export async function readSpotifyConfiguration(environment = process.env) {
  const environmentClientId = environment.MOONDOG_SPOTIFY_CLIENT_ID?.trim();
  if (environmentClientId) {
    return {
      clientId: normalizeClientId(environmentClientId),
      source: "environment",
    };
  }

  const settingsFile = resolveSpotifySettingsFile(environment);
  let source;
  try {
    source = await readFile(settingsFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw configurationError("Moondog could not read Spotify settings.", error);
  }

  let document;
  try {
    document = JSON.parse(source);
  } catch (error) {
    throw configurationError("Moondog Spotify settings are not valid JSON.", error);
  }

  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    document.version !== SETTINGS_VERSION ||
    Object.keys(document).sort().join(",") !== "client_id,version"
  ) {
    throw configurationError("Moondog Spotify settings use an unsupported shape.");
  }

  return {
    clientId: normalizeClientId(document.client_id),
    source: "settings",
  };
}

export async function writeSpotifyConfiguration(
  clientId,
  environment = process.env,
) {
  const normalized = normalizeClientId(clientId);
  const settingsFile = resolveSpotifySettingsFile(environment);
  await mkdir(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
  await writeFile(
    settingsFile,
    `${JSON.stringify(
      { version: SETTINGS_VERSION, client_id: normalized },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return { clientId: normalized, source: "settings" };
}
