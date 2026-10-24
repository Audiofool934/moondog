import { unwatchFile, watchFile } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveMoondogAuthFile } from "../runtime/pi/persistent-credential-store.mjs";

// The music service that plays songs. Apple Music plays whole songs or 30-second previews;
// NetEase Cloud Music plays through its own ncm-cli, for listeners in mainland China.
export const PLAYBACK_SERVICES = Object.freeze(["spotify", "apple_music", "netease"]);
export const DEFAULT_PLAYBACK_SERVICE = "spotify";

export function normalizePlaybackService(value) {
  return PLAYBACK_SERVICES.includes(value) ? value : null;
}

// One selection for every conversation in this process. The window and the terminal each run one,
// and watchPlaybackPreference keeps it in step with the other's saves.
// Persist before publishing a change; overlapping choices save in the order they were requested.
// The file is written even when this process already holds the value: the other may have changed it.
export function createPlaybackSelection({ service = DEFAULT_PLAYBACK_SERVICE, save } = {}) {
  let current = normalizePlaybackService(service) ?? DEFAULT_PLAYBACK_SERVICE;
  let changing = Promise.resolve();
  const listeners = new Set();
  const set = (service) => {
    const value = normalizePlaybackService(service);
    if (!value) throw new Error(`Unsupported music service: ${service}`);
    if (value !== current) {
      current = value;
      for (const listener of listeners) {
        try { listener(value); } catch { /* A surface cannot undo a saved choice. */ }
      }
    }
    return value;
  };
  return {
    get service() { return current; },
    set,
    change(service) {
      const work = changing.then(async () => {
        const value = normalizePlaybackService(service);
        if (!value) throw new Error(`Unsupported music service: ${service}`);
        await save?.(value);
        return set(value);
      });
      changing = work.catch(() => {});
      return work;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
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

// The terminal and the window each run their own core on this file. A service saved by one reaches
// the other's selection, which tells its picker and agents; onChange hears only those changes.
export function watchPlaybackPreference(selection, { environment = process.env, interval = 2000, onChange } = {}) {
  const file = resolvePlaybackPreferenceFile(environment);
  const follow = async () => {
    const saved = await readPlaybackPreference(environment);
    if (!saved || saved === selection.service) return;
    selection.set(saved);
    onChange?.(saved);
  };
  const listener = () => { void follow().catch(() => {}); };
  watchFile(file, { interval, persistent: false }, listener);
  return () => unwatchFile(file, listener);
}

/** The saved choice, or Spotify. */
export async function resolvePlaybackService(environment = process.env) {
  return await readPlaybackPreference(environment) ?? DEFAULT_PLAYBACK_SERVICE;
}
