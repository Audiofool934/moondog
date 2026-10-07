import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LOCALES, liveScreenTranslator, messageCatalogKeys, messageLocale, normalizeLocale, screenCatalog, systemLocale, translator } from "../../src/i18n/index.mjs";
import { readLanguagePreference, resolveListenerLocale, writeLanguagePreference } from "../../src/i18n/preferences.mjs";
import en from "../../src/i18n/messages/en.mjs";
import es from "../../src/i18n/messages/es.mjs";
import ja from "../../src/i18n/messages/ja.mjs";
import pt from "../../src/i18n/messages/pt.mjs";
import zh from "../../src/i18n/messages/zh.mjs";

test("every catalog has exactly the English keys with matching shapes", () => {
  const english = messageCatalogKeys("en").sort();
  for (const locale of Object.keys(LOCALES)) {
    assert.deepEqual(messageCatalogKeys(locale).sort(), english, `${locale} keys`);
    const t = translator(locale);
    for (const key of english) {
      // Rendering with empty parameters must not throw; strings stay strings.
      assert.equal(typeof t(key, { parts: [], names: "", count: 2 }), "string", `${locale} ${key}`);
      assert.equal(typeof { en, es, ja, pt, zh }[locale][key], typeof en[key], `${locale} ${key} shape`);
    }
  }
});

test("a translator falls back to English and rejects unknown keys", () => {
  assert.equal(translator("fr")("turn.cancelled"), "Cancelled further work.");
  assert.equal(translator("es")("turn.cancelled"), "Cancelé el resto.");
  assert.equal(translator("es").locale, "es");
  assert.throws(() => translator("en")("no.such.key"), /Unknown message/u);
});

test("locale names normalize from system and user spellings", () => {
  for (const [value, expected] of [["es_ES.UTF-8", "es"], ["es-MX", "es"], ["ZH_cn", "zh"], ["en_GB", "en"], ["fr_FR", null], ["", null], [undefined, null]]) {
    assert.equal(normalizeLocale(value), expected, String(value));
  }
  assert.equal(systemLocale({ LANG: "es_ES.UTF-8" }), "es");
  assert.equal(systemLocale({ MOONDOG_LANGUAGE: "zh", LANG: "es_ES.UTF-8" }), "zh");
  assert.equal(systemLocale({ LC_ALL: "C", LANG: "fr_FR.UTF-8" }), "en");
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
  for (const locale of Object.keys(LOCALES).filter(code => code !== "en")) {
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
});

test("the words Moondog reads itself work in every supported language", async () => {
  const { playbackFollowupIntent, queueCancellationRequested, unheardRequested, playbackDeviceExplicitlyRequested } =
    await import("../../src/core/spotify-listening-intent.mjs");
  const followups = [
    ["3", "ordinal:3"], ["第三个", "ordinal:3"], ["retry", "retry"],
    ["la tercera", "ordinal:3"], ["pon la 2", "ordinal:2"], ["otra vez", "retry"], ["otra versión", "alternative"], ["ponla en el altavoz", "retarget"],
    ["a terceira", "ordinal:3"], ["coloca a 2", "ordinal:2"], ["de novo", "retry"], ["outra versão", "alternative"], ["toca na caixa de som", "retarget"],
    ["3番", "ordinal:3"], ["三つ目", "ordinal:3"], ["もう一度", "retry"], ["別のバージョンにして", "alternative"], ["スピーカーで再生して", "retarget"],
    ["ジャズをSpotifyで再生して", null],
  ];
  for (const [text, expected] of followups) {
    const intent = playbackFollowupIntent(text);
    assert.equal(intent ? `${intent.kind}${intent.ordinal ? `:${intent.ordinal}` : ""}` : null, expected, text);
  }
  for (const text of ["cancel", "别加了", "cancela", "no añadas nada a la cola", "não adiciona nada na fila", "キャンセル", "キューに入れないで"]) {
    assert.equal(queueCancellationRequested(text), true, text);
  }
  for (const text of ["queue some jazz", "pon jazz en la cola", "coloca jazz na fila", "ジャズをキューに入れて"]) {
    assert.equal(queueCancellationRequested(text), false, text);
  }
  for (const text of ["songs I've never heard", "canciones que no haya escuchado", "músicas que eu ainda não ouvi", "聴いたことのない曲"]) {
    assert.equal(unheardRequested(text), true, text);
  }
  for (const text of ["ponla en mi altavoz", "toca no meu celular", "スマホで再生して"]) {
    assert.equal(playbackDeviceExplicitlyRequested(text, { deviceName: text.includes("altavoz") ? "speaker" : "phone" }), true, text);
  }
});
