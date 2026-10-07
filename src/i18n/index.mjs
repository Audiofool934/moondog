import en from "./messages/en.mjs";
import es from "./messages/es.mjs";
import zh from "./messages/zh.mjs";

// English is the source language; every other catalog falls back to it.
export const DEFAULT_LOCALE = "en";
export const LOCALES = Object.freeze({
  en: Object.freeze({ name: "English", nativeName: "English" }),
  es: Object.freeze({ name: "Spanish", nativeName: "Español" }),
  zh: Object.freeze({ name: "Simplified Chinese", nativeName: "简体中文" }),
});
const CATALOGS = { en, es, zh };

/** "es_ES.UTF-8", "es-MX" and "ES" all mean Spanish; anything unsupported is null. */
export function normalizeLocale(value) {
  if (typeof value !== "string") return null;
  const language = value.trim().toLowerCase().split(/[-_.@]/u)[0];
  return Object.hasOwn(LOCALES, language) ? language : null;
}

/** The locale a fresh install uses: an explicit override, then the system's own language. */
export function systemLocale(environment = process.env) {
  for (const name of ["MOONDOG_LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"]) {
    const locale = normalizeLocale(environment[name]);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

const LANGUAGE_NAMES = [
  ["en", /\b(?:english|ingl[eé]s)\b|英文|英语/iu],
  ["es", /\b(?:spanish|espa[nñ]ol|castellano)\b|西班牙语|西班牙文/iu],
  ["zh", /\b(?:chinese|mandarin|chino)\b|中文|汉语|普通话/iu],
];
const EXPLICIT_REQUEST = /\b(?:reply|respond|answer|write|explain|speak|talk)(?:\s+(?:to me|this|it))?\s+in\s+(\p{L}+)|\b(?:responde(?:me)?|cont[eé]stame|escr[ií]beme|h[aá]blame|explica(?:me)?)\s+en\s+(\p{L}+)|(?:用|使用|以)\s*(\p{Script=Han}{2,4}?)\s*(?:回答|回复|解释|说明|输出)/giu;

// Short function words and commands that rarely appear in the other language.
// Accented letters and inverted punctuation are strong Spanish evidence.
const WORDS = {
  en: new Set(["the", "an", "of", "and", "to", "play", "some", "song", "songs", "track", "tracks", "queue", "my", "i", "want",
    "please", "what", "is", "are", "more", "like", "something", "music", "put", "next", "add", "find", "with", "for", "this",
    "that", "it", "you", "can", "give", "thanks", "hi", "hello", "listen", "again", "stop", "skip", "pause", "who", "why", "how"]),
  es: new Set(["que", "de", "la", "el", "los", "las", "una", "unos", "unas", "por", "para", "con", "pon", "ponme", "quiero",
    "algo", "canciones", "cancion", "canción", "musica", "música", "cola", "reproduce", "toca", "añade", "agrega", "otra",
    "otro", "más", "mas", "y", "mi", "mis", "es", "está", "del", "al", "como", "qué", "cómo", "dame", "busca", "escuchar",
    "gracias", "hola", "favor", "salta", "pausa", "siguiente", "quién", "por qué"]),
};
const COMMANDS = {
  en: new Set(["play", "queue", "put", "add", "find", "give", "skip", "pause", "stop", "show", "tell", "recommend", "make"]),
  es: new Set(["pon", "ponme", "reproduce", "toca", "añade", "agrega", "busca", "dame", "salta", "pausa", "muestra", "dime", "recomienda", "haz", "quiero"]),
};

function explicitLocale(prose) {
  const requests = [...prose.matchAll(EXPLICIT_REQUEST)];
  for (const match of requests.reverse()) {
    const named = match[1] ?? match[2] ?? match[3];
    const found = LANGUAGE_NAMES.find(([, pattern]) => pattern.test(named));
    if (found) return found[0];
  }
  return null;
}

/**
 * The language to answer one message in: an explicit request, then the
 * message's own script and words, then the listener's configured language.
 * Quoted titles never decide it, because song names travel across languages.
 */
export function messageLocale(text, fallback = DEFAULT_LOCALE) {
  const configured = normalizeLocale(fallback) ?? DEFAULT_LOCALE;
  if (typeof text !== "string") return configured;
  const prose = text
    .replace(/^(?:Track|Artist): "(?:[^"\\\n]|\\.)*"[ \t]*$/gmu, "")
    .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|«[^»]*»|「[^」]*」|《[^》]*》/gu, "");
  const explicit = explicitLocale(prose);
  if (explicit) return explicit;
  if (/\p{Script=Han}/u.test(prose)) return "zh";
  const words = prose.normalize("NFC").toLocaleLowerCase("es").match(/\p{L}+/gu) ?? [];
  const scores = { en: 0, es: /[¿¡ñáéíóú]/u.test(prose.toLocaleLowerCase("es")) ? 2 : 0 };
  for (const locale of Object.keys(scores)) {
    for (const word of words) if (WORDS[locale].has(word)) scores[locale] += 1;
    if (COMMANDS[locale].has(words[0])) scores[locale] += 2;
  }
  if (scores.es > scores.en) return "es";
  if (scores.en > scores.es) return "en";
  return configured;
}

/** A lookup bound to one locale; a missing entry falls back to English. */
export function translator(locale) {
  const catalog = CATALOGS[normalizeLocale(locale) ?? DEFAULT_LOCALE];
  const t = (key, params = {}) => {
    const entry = catalog[key] ?? CATALOGS.en[key];
    if (entry === undefined) throw new Error(`Unknown message: ${key}`);
    return typeof entry === "function" ? entry(params) : entry;
  };
  t.locale = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  return t;
}

export function messageCatalogKeys(locale) {
  return Object.keys(CATALOGS[locale] ?? {});
}
