import de from "./messages/de.mjs";
import en from "./messages/en.mjs";
import es from "./messages/es.mjs";
import fr from "./messages/fr.mjs";
import it from "./messages/it.mjs";
import ja from "./messages/ja.mjs";
import ko from "./messages/ko.mjs";
import pt from "./messages/pt.mjs";
import zhHant from "./messages/zh-Hant.mjs";
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
  "zh-Hant": Object.freeze({ name: "Traditional Chinese", nativeName: "繁體中文" }),
  ko: Object.freeze({ name: "Korean", nativeName: "한국어" }),
  fr: Object.freeze({ name: "French", nativeName: "Français" }),
  de: Object.freeze({ name: "German", nativeName: "Deutsch" }),
  it: Object.freeze({ name: "Italian", nativeName: "Italiano" }),
});
const CATALOGS = { en, es, ja, pt, zh, "zh-Hant": zhHant, ko, fr, de, it };
// Screen text is keyed by its English sentence, gettext style; English needs no file.
// Replies come in every locale; the terminal's own screen text exists in these.
const SCREEN = { en: {}, es: esScreen, ja: jaScreen, pt: ptScreen, zh: zhScreen };
export const SCREEN_LOCALES = Object.freeze(Object.keys(SCREEN));
// Traditional Chinese falls back to Simplified before English.
const PARENT = { "zh-Hant": "zh" };

/** The Intl tag for numbers and plurals: Simplified is mainland, Traditional is Taiwan, Portuguese is Brazilian. */
export function intlLocale(code) {
  return { zh: "zh-CN", "zh-Hant": "zh-TW", pt: "pt-BR" }[code] ?? code;
}

const TRADITIONAL_CHINESE = new Set(["hant", "tw", "hk", "mo"]);

/** "es_ES.UTF-8", "es-MX" and "ES" all mean Spanish; "zh_TW" and "zh-Hant" mean Traditional Chinese; anything unsupported is null. */
export function normalizeLocale(value) {
  if (typeof value !== "string") return null;
  const [language, ...rest] = value.trim().toLowerCase().split(/[-_.@]/u);
  if (language === "zh") return !rest.includes("hans") && rest.some(part => TRADITIONAL_CHINESE.has(part)) ? "zh-Hant" : "zh";
  return Object.hasOwn(LOCALES, language) ? language : null;
}

/** The locale a fresh install uses: an explicit override, then the system's own language. */
export function systemLocale(environment = process.env) {
  for (const name of ["MOONDOG_LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"]) {
    // The C locale is a deliberate choice of plain English, not an unset value.
    if (/^(?:c|posix)(?:[.@]|$)/iu.test(environment[name] ?? "")) return DEFAULT_LOCALE;
    const locale = normalizeLocale(environment[name]);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

// Each language's name in the languages Moondog speaks. Traditional Chinese
// comes before Chinese, because its names contain the word for Chinese.
const LANGUAGE_NAMES = [
  ["zh-Hant", /\btraditional\s+chinese\b|\bchino\s+tradicional\b|\bchin[eê]s\s+tradicional\b|\bchinois\s+traditionnel\b|\btraditionell\p{L}*\s+chinesisch\b|\bcinese\s+tradizionale\b|繁體|繁体|正體|번체/iu],
  ["zh", /\b(?:chinese|mandarin|chino|chin[eê]s|chinois|chinesisch|cinese)\b|中文|汉语|漢語|普通话|普通話|华语|華語|中国語|중국어/iu],
  ["en", /\b(?:english|ingl[eéê]s|anglais|englisch|inglese)\b|英文|英语|英語|영어/iu],
  ["es", /\b(?:spanish|espa[nñ]ol|castellano|espanhol|espagnol|spanisch|spagnolo)\b|西班牙|スペイン語|스페인어/iu],
  ["pt", /\b(?:portuguese|portugu[eéê]s|portugais|portugiesisch|portoghese)\b|葡萄牙|ポルトガル語|포르투갈어/iu],
  ["ja", /\b(?:japanese|japon[eéê]s|japonais|japanisch|giapponese)\b|日本語|日语|日語|日文|일본어/iu],
  ["ko", /\b(?:korean|coreano|cor[eé]en|koreanisch)\b|韩语|韓語|韩文|韓文|韩国语|韓國語|韓国語|한국어/iu],
  ["fr", /\b(?:french|franc[eéê]s|fran[cç]ais|franz[öo]sisch|francese)\b|法语|法語|法文|フランス語|프랑스어/iu],
  ["de", /\b(?:german|alem[aá]n|alem[ãa]o|allemand|deutsch|tedesco)\b|德语|德語|德文|ドイツ語|독일어/iu],
  ["it", /\b(?:italian|italiano|italien|italienisch)\b|意大利|義大利|イタリア語|이탈리아어/iu],
];
// A Latin-script request names its language in one or two words ("in traditional Chinese").
const NAMED = String.raw`(\p{L}+(?:[ \t]+\p{L}+)?)`;
const EXPLICIT_REQUEST = new RegExp([
  String.raw`(?<!\p{L})(?:reply|respond|answer|write|explain|speak|talk)(?:\s+(?:to me|this|it))?\s+in\s+${NAMED}`,
  String.raw`(?<!\p{L})(?:responde(?:me)?|cont[eé]stame|escr[ií]beme|h[aá]blame|explica(?:me)?)\s+en\s+${NAMED}`,
  String.raw`(?<!\p{L})(?:responda|responde|fale|escreva|explique)(?:-me)?\s+em\s+${NAMED}`,
  String.raw`(?<!\p{L})(?:r[ée]ponds|r[ée]pondez|[ée]cris|[ée]crivez|parle|parlez|explique|expliquez)(?:-(?:moi|nous))?\s+en\s+${NAMED}`,
  String.raw`(?<!\p{L})(?:antworte|antwortet|schreib|schreibe|sprich|erkl[äa]re?)(?:\s+(?:mir|uns|bitte|es|das))*\s+(?:auf|in)\s+${NAMED}`,
  String.raw`(?<!\p{L})(?:rispondi(?:mi)?|scrivi(?:mi)?|parla(?:mi)?|spiega(?:mi)?)\s+in\s+${NAMED}`,
  String.raw`(?:用|使用|以)\s*(\p{Script=Han}{2,4}?)\s*(?:跟我|和我|给我|給我|对我|對我)?\s*(?:回答|回复|回覆|回復|解释|解釋|说明|說明|输出|輸出|写|寫|讲|講|说|說)`,
  String.raw`(\p{Script=Han}{2,4}|\p{Script=Katakana}{2,8}語)で(?:答|返事|返信|話|説明|書)`,
  String.raw`((?:\p{Script=Hangul}+\s)?\p{Script=Hangul}{1,6}어)\s*로\s*(?:대답|답|말|설명|써|작성|응답|얘기|이야기)`,
].join("|"), "giu");

// Common characters whose Simplified and Traditional forms differ, including the
// ones artist names and song titles use most. Text that uses only shared
// characters decides nothing.
const SIMPLIFIED = new Set("这们个来说时为会对后么过还发没问题听乐让给种点样经现从动进实与关开长东车门间爱气应头边见话认识办学体机无声华专辑队设电脑网络语写欢请谢帮换单张节数几吗调轻静觉场线团类风随暂继续该别荐试陈张刘杨黄赵吴郑许邓蒋孙马罗萧叶苏卢钟颜谭龙凤伟辉丽泪恋忆梦云飞岁湾国广岛离远谁娇录缘戏树桥涛剧艺术圣诞旧历压转响闹拥怀忧伤宝贝铁银钱号楼双归乡齐剑侠诗词兴举热愿读独奖优层简伦");
const TRADITIONAL = new Set("這們個來說時為會對後麼過還發沒問題聽樂讓給種點樣經現從動進實與關開長東車門間愛氣應頭邊見話認識辦學體機無聲華專輯隊設電腦網絡語寫歡請謝幫換單張節數幾嗎調輕靜覺場線團類風隨暫繼續該別薦試裝佇陳誇張劉楊黃趙吳鄭許鄧蔣孫馬羅蕭葉蘇盧鍾顏譚龍鳳偉輝麗淚戀憶夢雲飛歲灣國廣島離遠誰嬌錄緣戲樹橋濤劇藝術聖誕舊歷壓轉響鬧擁懷憂傷寶貝鐵銀錢號樓雙歸鄉齊劍俠詩詞興舉熱願讀獨獎優層簡倫");

function chineseLocale(prose, configured) {
  let simplified = 0;
  let traditional = 0;
  for (const character of prose) {
    if (SIMPLIFIED.has(character)) simplified += 1;
    else if (TRADITIONAL.has(character)) traditional += 1;
  }
  if (simplified !== traditional) return traditional > simplified ? "zh-Hant" : "zh";
  return configured === "zh-Hant" ? "zh-Hant" : "zh";
}

// Short function words and commands that are rare in the other Latin-script
// languages. Words two languages share (de, que, para, una, con) decide nothing.
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
  fr: new Set(["le", "les", "des", "une", "et", "je", "j", "qu", "vous", "nous", "est", "pas", "mets", "mettre", "joue", "jouer",
    "lance", "ajoute", "ajouter", "chanson", "chansons", "morceau", "morceaux", "musique", "attente", "quelque", "chose", "plus",
    "encore", "merci", "bonjour", "salut", "plaît", "écouter", "écoute", "suivant", "suivante", "arrête", "quoi", "pourquoi",
    "comment", "avec", "pour", "dans", "sur", "cette", "ça", "oui", "veux", "voudrais", "peux", "fais", "donne", "moi", "autre",
    "maintenant", "aussi", "très", "trouve", "cherche", "montre", "recommande", "propose", "titre", "artiste", "groupe", "mon",
    "aime", "jamais", "déjà", "nouveau", "nouvelle", "calme", "doux", "soir", "soirée", "enceinte", "téléphone", "ordinateur"]),
  de: new Set(["der", "die", "den", "dem", "ein", "eine", "einen", "einem", "einer", "und", "ich", "du", "mir", "mich", "mein",
    "meine", "meinen", "dir", "dich", "bitte", "spiel", "spiele", "spielen", "lied", "lieder", "musik", "warteschlange", "noch",
    "mehr", "etwas", "wer", "wie", "warum", "ist", "nicht", "auch", "mit", "für", "von", "zu", "zum", "zur", "auf", "aus",
    "danke", "hallo", "nächste", "nächsten", "nächstes", "jetzt", "gib", "zeig", "zeige", "suche", "finde", "füge", "füg",
    "hinzu", "empfiehl", "mach", "kannst", "hast", "habe", "hab", "wieder", "nochmal", "nein", "sie", "wir", "uns", "einfach",
    "ruhig", "ruhige", "ruhiges", "gerade", "gehört", "nie", "schon", "neue", "neues", "neuen", "bisschen", "paar", "titel",
    "künstler", "lautsprecher", "handy", "fernseher", "pausiere", "stoppe", "überspringe", "weiter", "zurück", "lauter",
    "leiser", "welche", "welcher", "welches", "heute", "abend", "oder", "aber", "sehr", "gut", "mal", "doch", "gern", "gerne"]),
  it: new Set(["il", "gli", "di", "della", "delle", "dello", "degli", "dei", "che", "per", "metti", "mettimi", "mettere", "suona",
    "suonami", "suonare", "riproduci", "aggiungi", "canzone", "canzoni", "brano", "brani", "coda", "qualcosa", "ancora",
    "grazie", "ciao", "favore", "ascoltare", "ascolta", "prossima", "prossimo", "chi", "perché", "sono", "è", "voglio",
    "vorrei", "puoi", "fammi", "dammi", "altra", "altro", "adesso", "anche", "molto", "bene", "mio", "mia", "miei", "mie",
    "questa", "questo", "quella", "quello", "nella", "nel", "alla", "allo", "trova", "consiglia", "consigliami", "fai",
    "proponi", "ferma", "sentire", "po", "già", "mai", "nuovo", "nuova", "nuove", "nuovi", "rilassante", "tranquillo",
    "tranquilla", "stasera", "sera", "cassa", "telefono", "cellulare", "gruppo", "sentito", "ascoltato", "alza", "abbassa",
    "piace", "piacciono"]),
};
const COMMANDS = {
  en: new Set(["play", "queue", "put", "add", "find", "give", "skip", "pause", "stop", "show", "tell", "recommend", "make"]),
  es: new Set(["pon", "ponme", "reproduce", "añade", "agrega", "busca", "dame", "salta", "muestra", "dime", "recomienda", "haz", "quiero"]),
  pt: new Set(["coloca", "coloque", "toque", "adiciona", "adicione", "bota", "põe", "procura", "mostra", "recomenda", "faz", "quero", "pula", "me"]),
  fr: new Set(["mets", "joue", "lance", "ajoute", "trouve", "cherche", "montre", "donne", "recommande", "propose", "fais", "arrête", "écoute", "je", "peux", "est"]),
  de: new Set(["spiel", "spiele", "füge", "füg", "gib", "zeig", "zeige", "suche", "finde", "mach", "empfiehl", "stell", "setz", "leg", "überspringe", "pausiere", "stoppe", "ich", "kannst", "bitte"]),
  it: new Set(["metti", "mettimi", "suona", "suonami", "riproduci", "aggiungi", "trova", "consiglia", "consigliami", "fammi", "dammi", "fai", "proponi", "ferma", "voglio", "vorrei", "ascolta", "puoi"]),
};
// Letters only one language writes are strong evidence; letters several share are weak evidence for each.
const MARKS = [
  [/[¿¡ñ]/u, ["es"]],
  [/[ãõ]/u, ["pt"]],
  [/[äöüß]/u, ["de"]],
  [/[œæëïÿîû]/u, ["fr"]],
  [/[ìò]/u, ["it"]],
  [/[çâêô]/u, ["pt", "fr"]],
  [/[èù]/u, ["fr", "it"]],
  [/à/u, ["pt", "fr", "it"]],
  [/[áíóú]/u, ["es", "pt"]],
  [/é/u, ["es", "pt", "fr", "it"]],
];

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
  // Hangul is only Korean and kana only Japanese; whichever the message uses more decides.
  const hangul = prose.match(/\p{Script=Hangul}/gu)?.length ?? 0;
  const kana = prose.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  if (hangul || kana) return hangul > kana ? "ko" : "ja";
  // Han characters without kana are Chinese, Simplified or Traditional by their forms.
  if (/\p{Script=Han}/u.test(prose)) return chineseLocale(prose, configured);
  const lower = prose.normalize("NFC").toLocaleLowerCase();
  const words = lower.match(/\p{L}+/gu) ?? [];
  const scores = { en: 0, es: 0, pt: 0, fr: 0, de: 0, it: 0 };
  for (const [pattern, locales] of MARKS) {
    if (pattern.test(lower)) for (const locale of locales) scores[locale] += locales.length === 1 ? 3 : 1;
  }
  for (const locale of Object.keys(scores)) {
    for (const word of words) if (WORDS[locale].has(word)) scores[locale] += 1;
    if (COMMANDS[locale].has(words[0])) scores[locale] += 2;
  }
  const ranked = Object.entries(scores).sort(([, a], [, b]) => b - a);
  return ranked[0][1] > ranked[1][1] ? ranked[0][0] : configured;
}

/** A lookup bound to one locale; a missing entry falls back to its parent language, then English. */
export function translator(locale) {
  const code = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  const catalogs = [CATALOGS[code], CATALOGS[PARENT[code]], CATALOGS.en].filter(Boolean);
  const t = (key, params = {}) => {
    const entry = catalogs.map(catalog => catalog[key]).find(value => value !== undefined);
    if (entry === undefined) throw new Error(`Unknown message: ${key}`);
    return typeof entry === "function" ? entry(params) : entry;
  };
  t.locale = code;
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

/** The language the terminal's screen text uses for a locale: its own, its parent's, or English. */
export function screenLocale(locale) {
  const code = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  if (SCREEN[code]) return code;
  return SCREEN[PARENT[code]] ? PARENT[code] : DEFAULT_LOCALE;
}

export function screenTranslator(locale) {
  const code = screenLocale(locale);
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
