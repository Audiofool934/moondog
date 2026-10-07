#!/usr/bin/env node
// Lists the screen sentences in the source and, for one language, the ones its
// catalog is missing:  node scripts/i18n-strings.mjs es
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SCREEN_SOURCES = ["src/surfaces/cli", "src/core/capability-catalog.mjs"];
const literal = String.raw`"((?:[^"\\]|\\.)*)"`;
const single = new RegExp(String.raw`\btr\(\s*${literal}`, "gu");
const marked = new RegExp(String.raw`\bN_\(\s*${literal}`, "gu");
const plural = new RegExp(String.raw`\btr\.n\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*${literal}\s*,\s*${literal}`, "gu");
const dynamic = /\btr(?:\.n)?\(\s*(?!["\s]|[^,()]+(?:\([^()]*\))?\s*,\s*")/gu;

/** Every tr("...") and tr.n(count, "...", "...") sentence, keyed by its English text. */
export async function screenSentences() {
  const sentences = new Map();
  const problems = [];
  const files = [];
  for (const entry of SCREEN_SOURCES) {
    if (entry.endsWith(".mjs")) files.push(entry);
    else files.push(...(await readdir(path.join(root, entry))).filter(file => file.endsWith(".mjs")).sort().map(name => path.join(entry, name)));
  }
  {
    for (const file of files) {
      const source = await readFile(path.join(root, file), "utf8");
      for (const match of [...source.matchAll(single), ...source.matchAll(marked)]) sentences.set(JSON.parse(`"${match[1]}"`), { file, plural: false });
      for (const match of source.matchAll(plural)) {
        sentences.set(JSON.parse(`"${match[2]}"`), { file, plural: true, one: JSON.parse(`"${match[1]}"`) });
      }
      for (const match of source.matchAll(dynamic)) {
        const line = source.slice(0, match.index).split("\n").length;
        problems.push(`${file}:${line} passes a non-literal to tr(); write the English sentence inline.`);
      }
    }
  }
  return { sentences, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const locale = process.argv[2];
  const { sentences, problems } = await screenSentences();
  if (problems.length) console.error(problems.join("\n"));
  if (!locale) {
    console.log(JSON.stringify([...sentences.keys()], null, 2));
  } else {
    const { default: catalog } = await import(pathToFileURL(path.join(root, "src/i18n/screen", `${locale}.mjs`)).href);
    const missing = [...sentences].filter(([english]) => catalog[english] === undefined)
      .map(([english, value]) => value.plural ? { one: value.one, other: english } : english);
    console.log(JSON.stringify(missing, null, 2));
  }
}
