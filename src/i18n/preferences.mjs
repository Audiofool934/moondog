import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveMoondogAuthFile } from "../runtime/pi/persistent-credential-store.mjs";
import { normalizeLocale, systemLocale } from "./index.mjs";

// Kept apart from runtime settings, whose strict shape older versions enforce.
export function resolveLanguagePreferenceFile(environment = process.env) {
  return path.join(path.dirname(resolveMoondogAuthFile(environment)), "language.json");
}

export async function readLanguagePreference(environment = process.env) {
  try {
    const document = JSON.parse(await readFile(resolveLanguagePreferenceFile(environment), "utf8"));
    return document?.version === 1 ? normalizeLocale(document.language) : null;
  } catch {
    // A missing or unreadable preference falls back to the system language.
    return null;
  }
}

export async function writeLanguagePreference(locale, environment = process.env) {
  const language = normalizeLocale(locale);
  if (!language) throw new Error(`Unsupported language: ${locale}`);
  const file = resolveLanguagePreferenceFile(environment);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify({ version: 1, language }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return language;
}

/** MOONDOG_LANGUAGE wins, then the saved choice, then the system language. */
export async function resolveListenerLocale(environment = process.env) {
  return normalizeLocale(environment.MOONDOG_LANGUAGE) ?? await readLanguagePreference(environment) ?? systemLocale(environment);
}
