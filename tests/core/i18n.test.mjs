import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LOCALES, SCREEN_LOCALES, liveScreenTranslator, messageCatalogKeys, messageLocale, normalizeLocale, screenCatalog, screenLocale, systemLocale, translator } from "../../src/i18n/index.mjs";
import { readLanguagePreference, resolveListenerLocale, writeLanguagePreference } from "../../src/i18n/preferences.mjs";
import de from "../../src/i18n/messages/de.mjs";
import en from "../../src/i18n/messages/en.mjs";
import es from "../../src/i18n/messages/es.mjs";
import fr from "../../src/i18n/messages/fr.mjs";
import it from "../../src/i18n/messages/it.mjs";
import ja from "../../src/i18n/messages/ja.mjs";
import ko from "../../src/i18n/messages/ko.mjs";
import pt from "../../src/i18n/messages/pt.mjs";
import zhHant from "../../src/i18n/messages/zh-Hant.mjs";
import zh from "../../src/i18n/messages/zh.mjs";

const CATALOGS = { en, es, ja, pt, zh, "zh-Hant": zhHant, ko, fr, de, it };

test("every catalog has exactly the English keys with matching shapes", () => {
  const english = messageCatalogKeys("en").sort();
  assert.deepEqual(Object.keys(LOCALES).sort(), Object.keys(CATALOGS).sort());
  for (const locale of Object.keys(LOCALES)) {
    assert.deepEqual(messageCatalogKeys(locale).sort(), english, `${locale} keys`);
    const t = translator(locale);
    for (const key of english) {
      // Rendering with empty parameters must not throw; strings stay strings.
      assert.equal(typeof t(key, { parts: [], names: "", count: 2 }), "string", `${locale} ${key}`);
      assert.equal(typeof CATALOGS[locale][key], typeof en[key], `${locale} ${key} shape`);
    }
  }
});

test("a translator falls back to English and rejects unknown keys", () => {
  assert.equal(translator("ru")("turn.cancelled"), "Cancelled further work.");
  assert.equal(translator("es")("turn.cancelled"), "Cancelé el resto.");
  assert.equal(translator("es").locale, "es");
  assert.equal(translator("zh_TW").locale, "zh-Hant");
  assert.equal(translator("zh-Hant")("turn.cancelled"), "已取消後續操作。");
  assert.throws(() => translator("en")("no.such.key"), /Unknown message/u);
});

test("locale names normalize from system and user spellings", () => {
  for (const [value, expected] of [
    ["es_ES.UTF-8", "es"], ["es-MX", "es"], ["ZH_cn", "zh"], ["en_GB", "en"], ["fr_FR", "fr"], ["de-AT", "de"], ["it_IT.UTF-8", "it"],
    ["ko_KR.UTF-8", "ko"], ["zh_TW.UTF-8", "zh-Hant"], ["zh-Hant-TW", "zh-Hant"], ["zh-HK", "zh-Hant"], ["zh-Hant", "zh-Hant"],
    ["zh-Hans-HK", "zh"], ["zh-Hans", "zh"], ["pt-PT", "pt"], ["ru_RU", null], ["", null], [undefined, null],
  ]) {
    assert.equal(normalizeLocale(value), expected, String(value));
  }
  assert.equal(systemLocale({ LANG: "es_ES.UTF-8" }), "es");
  assert.equal(systemLocale({ LANG: "zh_TW.UTF-8" }), "zh-Hant");
  assert.equal(systemLocale({ MOONDOG_LANGUAGE: "zh", LANG: "es_ES.UTF-8" }), "zh");
  assert.equal(systemLocale({ LC_ALL: "C", LANG: "fr_FR.UTF-8" }), "en");
  assert.equal(systemLocale({ LC_ALL: "ru_RU.UTF-8", LANG: "de_DE.UTF-8" }), "de");
});

test("a reply follows the message's language, then the listener's setting", () => {
  const cases = [
    ["pon algo de jazz en la cola", "en", "es"],
    ["¿qué está sonando?", "en", "es"],
    ["queue some jazz", "es", "en"],
    ["Play La Bamba", "es", "en"],
    ["Pon \"Take Five\"", "en", "es"],
    ["来点爵士乐", "es", "zh"],
    ["Ludwig x Hans Zimmer", "es", "es"],
    ["Ludwig x Hans Zimmer", "en", "en"],
    ["play something, reply in Spanish", "en", "es"],
    ["pon algo y responde en inglés", "es", "en"],
    ["用西班牙语回答：推荐几首歌", "en", "es"],
    ["Track: \"Canción de la noche\"\nWhat do you think?", "en", "en"],
    ["coloca umas músicas de jazz na fila", "en", "pt"],
    ["você pode tocar algo?", "es", "pt"],
    ["quero ouvir algo novo", "en", "pt"],
    ["quiero escuchar algo nuevo", "pt", "es"],
    ["responda em inglês, por favor", "pt", "en"],
    ["ジャズをキューに入れて", "en", "ja"],
    ["日本語で答えて", "en", "ja"],
    ["用日语回答", "en", "ja"],
    ["米津玄師", "en", "zh"],
    ["Ludwig x Hans Zimmer", "pt", "pt"],
    ["Ludwig x Hans Zimmer", "ja", "ja"],
    ["來點爵士樂", "en", "zh-Hant"],
    ["幫我放一首周杰倫的歌", "zh", "zh-Hant"],
    ["来点爵士乐", "zh-Hant", "zh"],
    ["播放伍佰", "zh-Hant", "zh-Hant"],
    ["播放陳奕迅的浮誇", "en", "zh-Hant"],
    ["播放陈奕迅的浮夸", "zh-Hant", "zh"],
    ["播放伍佰", "en", "zh"],
    ["請用英文回答", "zh-Hant", "en"],
    ["用繁體中文回答", "en", "zh-Hant"],
    ["재즈 좀 틀어줘", "en", "ko"],
    ["あいみょんの曲を再生して", "ko", "ja"],
    ["아이유 노래 틀어줘", "ja", "ko"],
    ["영어로 대답해 줘", "ko", "en"],
    ["mets du jazz dans la file d'attente", "en", "fr"],
    ["joue quelque chose de calme", "en", "fr"],
    ["je veux écouter Radiohead", "de", "fr"],
    ["réponds en anglais", "fr", "en"],
    ["spiel etwas Ruhiges", "en", "de"],
    ["füg ein paar Songs zur Warteschlange hinzu", "en", "de"],
    ["antworte mir bitte auf Englisch", "de", "en"],
    ["metti un po' di jazz in coda", "en", "it"],
    ["riproduci qualcosa di rilassante", "es", "it"],
    ["rispondi in inglese", "it", "en"],
    ["reply in traditional Chinese", "en", "zh-Hant"],
    ["responde en chino tradicional", "es", "zh-Hant"],
    ["Ludwig x Hans Zimmer", "ko", "ko"],
    ["Ludwig x Hans Zimmer", "de", "de"],
  ];
  for (const [text, setting, expected] of cases) assert.equal(messageLocale(text, setting), expected, text);
});

test("the saved language survives restarts, and MOONDOG_LANGUAGE still wins", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-language-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { MOONDOG_CONFIG_HOME: root, LANG: "en_US.UTF-8" };
  assert.equal(await readLanguagePreference(environment), null);
  assert.equal(await resolveListenerLocale(environment), "en");
  await writeLanguagePreference("es", environment);
  assert.equal(await resolveListenerLocale(environment), "es");
  assert.equal(await resolveListenerLocale({ ...environment, MOONDOG_LANGUAGE: "zh" }), "zh");
  await assert.rejects(writeLanguagePreference("klingon", environment), /Unsupported language/u);
});

test("every screen sentence is translated in every language, with the same placeholders", async () => {
  const { screenSentences } = await import("../../scripts/i18n-strings.mjs");
  const { sentences, problems } = await screenSentences();
  assert.deepEqual(problems, []);
  assert.ok(sentences.size > 800);
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/gu)].map(match => match[1]).sort();
  for (const locale of SCREEN_LOCALES.filter(code => code !== "en")) {
    const catalog = screenCatalog(locale);
    for (const [english, { plural }] of sentences) {
      const entry = catalog[english];
      assert.ok(entry !== undefined, `${locale} is missing: ${english.slice(0, 80)}`);
      const forms = typeof entry === "string" ? [entry] : [entry.other];
      if (typeof entry !== "string") assert.ok(plural && typeof entry.one === "string", `${locale} plural shape: ${english.slice(0, 60)}`);
      for (const form of forms) assert.deepEqual(placeholders(form), placeholders(english), `${locale} placeholders: ${english.slice(0, 60)}`);
    }
    // A sentence the source no longer uses is dead weight that hides drift.
    for (const english of Object.keys(catalog)) assert.ok(sentences.has(english), `${locale} has an unused sentence: ${english.slice(0, 80)}`);
  }
});

test("screen text follows the live language and pluralizes per language", () => {
  let locale = "en";
  const tr = liveScreenTranslator(() => locale);
  assert.equal(tr("Bring your music"), "Bring your music");
  assert.equal(tr.n(1, "{count} song", "{count} songs"), "1 song");
  locale = "es";
  assert.equal(tr("Bring your music"), "Trae tu música");
  assert.equal(tr.n(1, "{count} song", "{count} songs"), "1 canción");
  assert.equal(tr.n(1200, "{count} song", "{count} songs"), "1200 canciones");
  locale = "zh";
  assert.equal(tr.n(3, "{count} song", "{count} songs"), "3 首歌");
  assert.equal(tr("A sentence nobody translated"), "A sentence nobody translated");
  // Screen text exists in fewer languages than replies: Traditional Chinese reads Simplified, the rest English.
  locale = "zh-Hant";
  assert.equal(tr.n(3, "{count} song", "{count} songs"), "3 首歌");
  locale = "fr";
  assert.equal(tr("Bring your music"), "Bring your music");
  assert.equal(tr.n(1200, "{count} song", "{count} songs"), "1,200 songs");
  assert.deepEqual(["zh-Hant", "ko", "fr", "de", "it"].map(screenLocale), ["zh", "en", "en", "en", "en"]);
});

test("the words Moondog reads itself work in every supported language", async () => {
  const { queueCancellationRequested, unheardRequested } = await import("../../src/core/spotify-listening-intent.mjs");
  for (const text of ["cancel", "别加了", "cancela", "no añadas nada a la cola", "não adiciona nada na fila", "キャンセル", "キューに入れないで"]) {
    assert.equal(queueCancellationRequested(text), true, text);
  }
  for (const text of ["queue some jazz", "pon jazz en la cola", "coloca jazz na fila", "ジャズをキューに入れて"]) {
    assert.equal(queueCancellationRequested(text), false, text);
  }
  for (const text of ["songs I've never heard", "canciones que no haya escuchado", "músicas que eu ainda não ouvi", "聴いたことのない曲"]) {
    assert.equal(unheardRequested(text), true, text);
  }
});
