import { unwatchFile, watchFile } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { readPlaybackPreference, resolvePlaybackPreferenceFile } from "./playback-preferences.mjs";
import { resolveMoondogAuthFile } from "../runtime/pi/persistent-credential-store.mjs";

// The first launch asks for a music service and a model, once, on whichever surface opens first.
// first-run.json, kept beside playback.json, says the first run is over, so the terminal and the
// window ask once between them. It ends when the listener skips it, or once a music service is
// saved and a model can answer; signing out later does not bring it back.
export function resolveFirstRunFile(environment = process.env) {
  return path.join(path.dirname(resolveMoondogAuthFile(environment)), "first-run.json");
}

async function readFinished(environment) {
  try {
    const document = JSON.parse(await readFile(resolveFirstRunFile(environment), "utf8"));
    return document?.version === 1 && typeof document.finished_at === "string";
  } catch {
    return false;
  }
}

async function writeFinished(environment, { skipped }) {
  const file = resolveFirstRunFile(environment);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const document = { version: 1, finished_at: new Date().toISOString(), skipped: skipped === true };
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function createFirstRun({ environment = process.env, interval = 2000 } = {}) {
  return {
    // What the first run still asks for. A service counts once it is saved, even as Spotify, the
    // default; the model counts once the surface's own agent can answer (modelReady).
    async state({ modelReady = false } = {}) {
      const [finished, service] = await Promise.all([readFinished(environment), readPlaybackPreference(environment)]);
      const over = finished || Boolean(service && modelReady);
      if (over && !finished) await writeFinished(environment, { skipped: false }).catch(() => {});
      return { needed: !over, service, model: modelReady === true };
    },
    // The listener skipped the rest, or the surface's last step ended it.
    finish: ({ skipped = false } = {}) => writeFinished(environment, { skipped }),
    // Hears a save on either side: the first run ended there, or a music service was chosen. A model
    // reaches the surface through its own agent, which watchRuntimeSettings rebuilds.
    watch(listener) {
      const files = [resolveFirstRunFile(environment), resolvePlaybackPreferenceFile(environment)];
      const changed = (now, before) => { if (now.mtimeMs !== before.mtimeMs) listener(); };
      for (const file of files) watchFile(file, { interval, persistent: false }, changed);
      return () => { for (const file of files) unwatchFile(file, changed); };
    },
  };
}
