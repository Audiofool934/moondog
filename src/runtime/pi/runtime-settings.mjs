import { unwatchFile, watchFile } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import { resolveMoondogAuthFile } from "./persistent-credential-store.mjs";

const SETTINGS_VERSION = 1;
// Pi's thinking levels. Each model supports a subset; the runtime clamps to it.
export const EFFORT_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
// The scale the window and /effort offer for every model that thinks.
export const EFFORT_SCALE = Object.freeze(["off", "low", "medium", "high", "xhigh", "max"]);

// A level the model lacks steps down to the nearest one it has, so a choice never costs more than it
// said, but never down to no thinking; with nothing below, it takes the lightest level the model has.
export function clampEffort(model, level) {
  const supported = getSupportedThinkingLevels(model);
  if (supported.includes(level)) return level;
  const at = EFFORT_LEVELS.indexOf(level);
  for (let index = at - 1; index > 0; index -= 1) if (supported.includes(EFFORT_LEVELS[index])) return EFFORT_LEVELS[index];
  for (let index = Math.max(at + 1, 1); index < EFFORT_LEVELS.length; index += 1) if (supported.includes(EFFORT_LEVELS[index])) return EFFORT_LEVELS[index];
  return supported[0] ?? "off";
}

function settingsError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "MoondogRuntimeSettingsError";
  error.code = "runtime_settings_invalid";
  return error;
}

function normalizeSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw settingsError("Moondog runtime settings must be an object.");
  }

  const provider =
    typeof value.provider === "string"
      ? value.provider.trim().toLowerCase()
      : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (!provider || !model) {
    throw settingsError(
      "Moondog runtime settings require a provider and model.",
    );
  }
  if (value.effort === undefined) return { provider, model };
  if (!EFFORT_LEVELS.includes(value.effort)) {
    throw settingsError("Moondog runtime settings use an unknown effort level.");
  }
  return { provider, model, effort: value.effort };
}

export function resolveMoondogSettingsFile(environment = process.env) {
  return path.join(
    path.dirname(resolveMoondogAuthFile(environment)),
    "settings.json",
  );
}

export async function readPiRuntimeSelection(environment = process.env) {
  const settingsFile = resolveMoondogSettingsFile(environment);
  let source;
  try {
    source = await readFile(settingsFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw settingsError("Moondog could not read runtime settings.", error);
  }

  let document;
  try {
    document = JSON.parse(source);
  } catch (error) {
    throw settingsError("Moondog runtime settings are not valid JSON.", error);
  }
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    document.version !== SETTINGS_VERSION ||
    !["model,provider,version", "effort,model,provider,version"].includes(
      Object.keys(document).sort().join(","),
    )
  ) {
    throw settingsError("Moondog runtime settings use an unsupported shape.");
  }
  return normalizeSelection(document);
}

export async function writePiRuntimeSelection(
  selection,
  environment = process.env,
) {
  const normalized = normalizeSelection(selection);
  const settingsFile = resolveMoondogSettingsFile(environment);
  await mkdir(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
  await writeFile(
    settingsFile,
    `${JSON.stringify({ version: SETTINGS_VERSION, ...normalized }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return normalized;
}

// The terminal and the window each build their agent from settings.json and auth.json. A model
// chosen, or a sign-in made, on one side reaches the other through this watch. onChange hears the
// saved selection, or undefined when none is saved; the surface decides whether to rebuild, with
// runtimeBehindSelection.
// The second argument says which file changed: "settings" (the default), "auth" (a sign-in),
// "endpoints" (an endpoint added, edited or removed) or "models" (the window's menu list).
export function watchRuntimeSettings({ environment = process.env, interval = 2000, onChange } = {}) {
  const directory = path.dirname(resolveMoondogAuthFile(environment));
  const files = { settings: resolveMoondogSettingsFile(environment), auth: resolveMoondogAuthFile(environment),
    endpoints: path.join(directory, "endpoints.json"), models: path.join(directory, "models.json") };
  const listeners = Object.entries(files).map(([changed, file]) => {
    const listener = (now, before) => {
      if (now.mtimeMs === before.mtimeMs) return;
      void readPiRuntimeSelection(environment).then((selection) => onChange?.(selection, changed), () => {});
    };
    watchFile(file, { interval, persistent: false }, listener);
    return [file, listener];
  });
  return () => { for (const [file, listener] of listeners) unwatchFile(file, listener); };
}
