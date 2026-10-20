import assert from "node:assert/strict";
import test from "node:test";
import { LOCALES } from "../../src/i18n/index.mjs";
import { WINDOW_LOCALES, languageTag, windowLocale, windowStringKeys, windowStrings } from "../../app/strings.mjs";

test("the window speaks every language the core replies in, with every string", () => {
  assert.deepEqual([...WINDOW_LOCALES].sort(), Object.keys(LOCALES).sort());
  const english = windowStringKeys("en").sort();
  for (const locale of WINDOW_LOCALES) {
    assert.deepEqual(windowStringKeys(locale).sort(), english, `${locale} keys`);
    const t = windowStrings(locale);
    for (const key of english) assert.ok(t(key).trim(), `${locale} ${key}`);
  }
});

test("the window picks its language from the system's preferred list", () => {
  assert.equal(windowLocale(["zh-Hant-TW", "en-US"]), "zh-Hant");
  assert.equal(windowLocale(["zh-Hans-CN"]), "zh");
  assert.equal(windowLocale(["zh-HK"]), "zh-Hant");
  assert.equal(windowLocale(["pt-PT", "en"]), "pt");
  assert.equal(windowLocale(["ru-RU", "de-DE"]), "de");
  assert.equal(windowLocale(["ru-RU"]), "en");
  assert.equal(languageTag("zh"), "zh-Hans");
  assert.equal(windowStrings("ko")("menuQuit"), "Moondog 종료");
});
