import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveMoondogAuthFile } from "../runtime/pi/persistent-credential-store.mjs";

// The music service that plays songs. Apple Music plays 30-second previews for now;
// a later Music.app player can take the same value.
export const PLAYBACK_SERVICES = Object.freeze(["spotify", "apple_music"]);
export const DEFAULT_PLAYBACK_SERVICE = "spotify";

export function normalizePlaybackService(value) {
  return PLAYBACK_SERVICES.includes(value) ? value : null;
}

// Kept next to the language preference, apart from runtime settings.
export function resolvePlaybackPreferenceFile(environment = process.env) {
  return path.join(path.dirname(resolveMoondogAuthFile(environment)), "playback.json");
}

export async function readPlaybackPreference(environment = process.env) {
  try {
    const document = JSON.parse(await readFile(resolvePlaybackPreferenceFile(environment), "utf8"));
    return document?.version === 1 ? normalizePlaybackService(document.service) : null;
  } catch {
    // A missing or unreadable preference falls back to Spotify.
    return null;
  }
}

export async function writePlaybackPreference(service, environment = process.env) {
  const value = normalizePlaybackService(service);
  if (!value) throw new Error(`Unsupported music service: ${service}`);
  const file = resolvePlaybackPreferenceFile(environment);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify({ version: 1, service: value }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return value;
}

/** The saved choice, or Spotify. */
export async function resolvePlaybackService(environment = process.env) {
  return await readPlaybackPreference(environment) ?? DEFAULT_PLAYBACK_SERVICE;
}
