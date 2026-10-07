import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LOCALES, messageCatalogKeys, messageLocale, normalizeLocale, systemLocale, translator } from "../../src/i18n/index.mjs";
import { readLanguagePreference, resolveListenerLocale, writeLanguagePreference } from "../../src/i18n/preferences.mjs";
import en from "../../src/i18n/messages/en.mjs";
import es from "../../src/i18n/messages/es.mjs";
import zh from "../../src/i18n/messages/zh.mjs";

test("every catalog has exactly the English keys with matching shapes", () => {
  const english = messageCatalogKeys("en").sort();
  for (const locale of Object.keys(LOCALES)) {
    assert.deepEqual(messageCatalogKeys(locale).sort(), english, `${locale} keys`);
    const t = translator(locale);
    for (const key of english) {
      // Rendering with empty parameters must not throw; strings stay strings.
      assert.equal(typeof t(key, { parts: [], names: "", count: 2 }), "string", `${locale} ${key}`);
      assert.equal(typeof { en, es, zh }[locale][key], typeof en[key], `${locale} ${key} shape`);
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
