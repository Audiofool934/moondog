import en from "./messages/en.mjs";
import es from "./messages/es.mjs";
import zh from "./messages/zh.mjs";
import esScreen from "./screen/es.mjs";
import zhScreen from "./screen/zh.mjs";

// English is the source language; every other catalog falls back to it.
export const DEFAULT_LOCALE = "en";
export const LOCALES = Object.freeze({
  en: Object.freeze({ name: "English", nativeName: "English" }),
  es: Object.freeze({ name: "Spanish", nativeName: "Español" }),
  zh: Object.freeze({ name: "Simplified Chinese", nativeName: "简体中文" }),
});
const CATALOGS = { en, es, zh };
// Screen text is keyed by its English sentence, gettext style; English needs no file.
const SCREEN = { en: {}, es: esScreen, zh: zhScreen };

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

const fill = (text, params) => text.replace(/\{(\w+)\}/gu, (match, name) => params[name] ?? match);

/**
 * Screen text for one locale. Call tr("English sentence", { name }) with
 * {name} placeholders, and tr.n(count, "{count} song", "{count} songs") for
 * plurals. Keep the English as plain string literals: a test extracts them
 * to check that every catalog translates every sentence.
 */
const screenTranslators = new Map();

export function screenTranslator(locale) {
  const code = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  if (!screenTranslators.has(code)) screenTranslators.set(code, createScreenTranslator(code));
  return screenTranslators.get(code);
}

function createScreenTranslator(code) {
  const catalog = SCREEN[code];
  const numbers = new Intl.NumberFormat(code === "zh" ? "zh-CN" : code);
  const plurals = new Intl.PluralRules(code === "zh" ? "zh-CN" : code);
  const tr = (english, params = {}) => fill(typeof catalog[english] === "string" ? catalog[english] : english, params);
  tr.n = (count, one, other, params = {}) => {
    const values = { ...params, count: Number.isFinite(count) ? numbers.format(count) : count };
    const entry = catalog[other];
    if (typeof entry === "string") return fill(entry, values);
    if (entry && typeof entry === "object") return fill(entry[plurals.select(count)] ?? entry.other, values);
    return fill(count === 1 ? one : other, values);
  };
  tr.number = value => Number.isFinite(value) ? numbers.format(value) : value;
  // For a sentence marked with N_() where it was defined, such as a command list.
  tr.marked = (english, params = {}) => tr(english, params);
  tr.locale = code;
  return tr;
}

/** Marks an English sentence for extraction where no translator exists yet. */
export const N_ = text => text;

/** A translator that follows a changing locale, such as the /language choice. */
export function liveScreenTranslator(getLocale) {
  const current = () => screenTranslator(getLocale());
  const tr = (english, params) => current()(english, params);
  tr.n = (...args) => current().n(...args);
  tr.number = value => current().number(value);
  tr.marked = (english, params) => current().marked(english, params);
  Object.defineProperty(tr, "locale", { get: () => current().locale });
  return tr;
}

export function screenCatalog(locale) {
  return SCREEN[locale] ?? {};
}
