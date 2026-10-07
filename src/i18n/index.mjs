import en from "./messages/en.mjs";
import es from "./messages/es.mjs";
import ja from "./messages/ja.mjs";
import pt from "./messages/pt.mjs";
import zh from "./messages/zh.mjs";
import esScreen from "./screen/es.mjs";
import jaScreen from "./screen/ja.mjs";
import ptScreen from "./screen/pt.mjs";
import zhScreen from "./screen/zh.mjs";

// English is the source language; every other catalog falls back to it.
export const DEFAULT_LOCALE = "en";
export const LOCALES = Object.freeze({
  en: Object.freeze({ name: "English", nativeName: "English" }),
  es: Object.freeze({ name: "Spanish", nativeName: "Español" }),
  ja: Object.freeze({ name: "Japanese", nativeName: "日本語" }),
  pt: Object.freeze({ name: "Brazilian Portuguese", nativeName: "Português (Brasil)" }),
  zh: Object.freeze({ name: "Simplified Chinese", nativeName: "简体中文" }),
});
const CATALOGS = { en, es, ja, pt, zh };
// Screen text is keyed by its English sentence, gettext style; English needs no file.
const SCREEN = { en: {}, es: esScreen, ja: jaScreen, pt: ptScreen, zh: zhScreen };

/** The Intl tag for numbers and plurals: Moondog's Chinese is Simplified and its Portuguese is Brazilian. */
export function intlLocale(code) {
  return { zh: "zh-CN", pt: "pt-BR" }[code] ?? code;
}

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
  ["en", /\b(?:english|ingl[eéê]s)\b|英文|英语|英語/iu],
  ["es", /\b(?:spanish|espa[nñ]ol|castellano|espanhol)\b|西班牙语|西班牙文|スペイン語/iu],
  ["pt", /\b(?:portuguese|portugu[eé]s|portugu[eê]s)\b|葡萄牙语|ポルトガル語/iu],
  ["ja", /\b(?:japanese|japon[eé]s|japon[eê]s)\b|日本語|日语|日文/iu],
  ["zh", /\b(?:chinese|mandarin|chino|chin[eê]s)\b|中文|汉语|普通话|中国語/iu],
];
const EXPLICIT_REQUEST = new RegExp([
  String.raw`\b(?:reply|respond|answer|write|explain|speak|talk)(?:\s+(?:to me|this|it))?\s+in\s+(\p{L}+)`,
  String.raw`\b(?:responde(?:me)?|cont[eé]stame|escr[ií]beme|h[aá]blame|explica(?:me)?)\s+en\s+(\p{L}+)`,
  String.raw`\b(?:responda|responde|fale|escreva|explique)(?:-me)?\s+em\s+(\p{L}+)`,
  String.raw`(?:用|使用|以)\s*(\p{Script=Han}{2,4}?)\s*(?:回答|回复|解释|说明|输出)`,
  String.raw`(\p{Script=Han}{2,4}|\p{Script=Katakana}{2,8}語)で(?:答|返事|返信|話|説明|書)`,
].join("|"), "giu");

// Short function words and commands that are rare in the other Latin-script
// languages. Words Spanish and Portuguese share (de, que, para, algo) decide nothing.
const WORDS = {
  en: new Set(["the", "an", "of", "and", "to", "play", "some", "song", "songs", "track", "tracks", "queue", "my", "i", "want",
    "please", "what", "is", "are", "more", "like", "something", "music", "put", "next", "add", "find", "with", "for", "this",
    "that", "it", "you", "can", "give", "thanks", "hi", "hello", "listen", "again", "stop", "skip", "pause", "who", "why", "how"]),
  es: new Set(["la", "el", "los", "las", "una", "unos", "unas", "con", "pon", "ponme", "quiero", "canciones", "cancion",
    "canción", "cola", "reproduce", "añade", "agrega", "otra", "otro", "más", "y", "mi", "mis", "es", "está", "del", "al",
    "qué", "cómo", "dame", "escuchar", "gracias", "hola", "favor", "salta", "siguiente", "quién", "ahora", "vez"]),
  pt: new Set(["você", "voce", "não", "nao", "uma", "umas", "um", "uns", "coloca", "coloque", "toque", "tocar", "adiciona",
    "adicione", "quero", "músicas", "musicas", "fila", "mais", "também", "obrigado", "obrigada", "oi", "olá", "isso", "essa",
    "esse", "da", "dos", "das", "na", "nas", "pra", "ela", "meu", "minha", "outra", "outro", "próxima", "agora", "ouvir",
    "escutar", "põe", "bota", "pula", "favor", "tá", "está", "é"]),
};
const COMMANDS = {
  en: new Set(["play", "queue", "put", "add", "find", "give", "skip", "pause", "stop", "show", "tell", "recommend", "make"]),
  es: new Set(["pon", "ponme", "reproduce", "añade", "agrega", "busca", "dame", "salta", "muestra", "dime", "recomienda", "haz", "quiero"]),
  pt: new Set(["coloca", "coloque", "toque", "adiciona", "adicione", "bota", "põe", "procura", "mostra", "recomenda", "faz", "quero", "pula", "me"]),
};
// Letters only one of the two languages writes are strong evidence; shared accents are weak evidence for both.
const MARKS = { es: /[¿¡ñ]/u, pt: /[ãõçâêô]/u, shared: /[áéíóú]/u };

function explicitLocale(prose) {
  const requests = [...prose.matchAll(EXPLICIT_REQUEST)];
  for (const match of requests.reverse()) {
    const named = match.slice(1).find(Boolean);
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
    .replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|«[^»]*»|「[^」]*」|『[^』]*』|《[^》]*》/gu, "");
  const explicit = explicitLocale(prose);
  if (explicit) return explicit;
  // Kana is only Japanese; Han characters without kana are read as Chinese.
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(prose)) return "ja";
  if (/\p{Script=Han}/u.test(prose)) return "zh";
  const lower = prose.normalize("NFC").toLocaleLowerCase();
  const words = lower.match(/\p{L}+/gu) ?? [];
  const shared = MARKS.shared.test(lower) ? 1 : 0;
  const scores = { en: 0, es: (MARKS.es.test(lower) ? 3 : 0) + shared, pt: (MARKS.pt.test(lower) ? 3 : 0) + shared };
  for (const locale of Object.keys(scores)) {
    for (const word of words) if (WORDS[locale].has(word)) scores[locale] += 1;
    if (COMMANDS[locale].has(words[0])) scores[locale] += 2;
  }
  const ranked = Object.entries(scores).sort(([, a], [, b]) => b - a);
  return ranked[0][1] > ranked[1][1] ? ranked[0][0] : configured;
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
  const numbers = new Intl.NumberFormat(intlLocale(code));
  const plurals = new Intl.PluralRules(intlLocale(code));
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
