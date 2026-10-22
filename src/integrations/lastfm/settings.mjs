import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveMoondogAuthFile } from "../../runtime/pi/persistent-credential-store.mjs";

const SETTINGS_VERSION = 1;
// Last.fm API keys are 32 hexadecimal characters. Reading public history needs only the key, never the shared secret.
const apiKeyPattern = /^[a-f0-9]{32}$/u;

export const LASTFM_API_ROOT = "https://ws.audioscrobbler.com/2.0/";

// Moondog's own key, registered to the project. Reading public listening needs only this
// key, so it ships with the source; a listener's own key in settings or the environment wins.
export const LASTFM_PROJECT_API_KEY = "396133c344735725f65b322ece17a2da";

function settingsError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "MoondogLastfmSettingsError";
  error.code = "lastfm_settings_invalid";
  return error;
}

export function normalizeLastfmApiKey(value) {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!apiKeyPattern.test(key)) {
    throw settingsError("A Last.fm API key is 32 letters and numbers. Copy the API key, not the shared secret.");
  }
  return key;
}

export function resolveLastfmSettingsFile(environment = process.env) {
  return path.join(path.dirname(resolveMoondogAuthFile(environment)), "lastfm.json");
}

// Tests and local mirrors may point Moondog at another API root; only https, or http on this machine.
function apiRoot(environment) {
  const configured = environment.MOONDOG_LASTFM_API_ROOT?.trim();
  if (!configured) return LASTFM_API_ROOT;
  let url;
  try { url = new URL(configured); } catch { throw settingsError("MOONDOG_LASTFM_API_ROOT must be a URL."); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
    throw settingsError("MOONDOG_LASTFM_API_ROOT must use https, or http on this machine.");
  }
  return url.href;
}

/** The key Moondog reads Last.fm with: the environment, then this machine's settings, then the project's own. */
export async function readLastfmConfiguration(environment = process.env) {
  const root = apiRoot(environment);
  const environmentKey = environment.MOONDOG_LASTFM_API_KEY?.trim();
  if (environmentKey) return { apiKey: normalizeLastfmApiKey(environmentKey), source: "environment", root };
  let source;
  try {
    source = await readFile(resolveLastfmSettingsFile(environment), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw settingsError("Moondog could not read its Last.fm settings.", error);
  }
  if (source !== undefined) {
    let document;
    try { document = JSON.parse(source); } catch (error) { throw settingsError("Moondog's Last.fm settings are not valid JSON.", error); }
    if (!document || typeof document !== "object" || document.version !== SETTINGS_VERSION) {
      throw settingsError("Moondog's Last.fm settings are in an unknown format.");
    }
    return { apiKey: normalizeLastfmApiKey(document.api_key), source: "settings", root };
  }
  return LASTFM_PROJECT_API_KEY ? { apiKey: LASTFM_PROJECT_API_KEY, source: "moondog", root } : undefined;
}

export async function writeLastfmConfiguration(apiKey, environment = process.env) {
  const normalized = normalizeLastfmApiKey(apiKey);
  const settingsFile = resolveLastfmSettingsFile(environment);
  await mkdir(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
  await writeFile(settingsFile, `${JSON.stringify({ version: SETTINGS_VERSION, api_key: normalized }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { apiKey: normalized, source: "settings", root: apiRoot(environment) };
}
