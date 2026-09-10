import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveMoondogAuthFile } from "./persistent-credential-store.mjs";

const SETTINGS_VERSION = 1;

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
  return { provider, model };
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
    Object.keys(document).sort().join(",") !== "model,provider,version"
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
