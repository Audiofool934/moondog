import assert from "node:assert/strict";
import test from "node:test";

import { nameFitsLanguage } from "../../src/core/moondog-application.mjs";

test("a record's name fits the language Moondog is set to", () => {
  // Kanji alone is Japanese as much as Chinese, so the setting decides.
  for (const name of ["月夜", "星空", "雨音"]) {
    assert.equal(nameFitsLanguage(name, "ja"), true, name);
    assert.equal(nameFitsLanguage(name, "zh"), true, name);
  }
  assert.equal(nameFitsLanguage("夜のテープ", "ja"), true);
  assert.equal(nameFitsLanguage("夜のテープ", "zh"), false);
  assert.equal(nameFitsLanguage("밤의 테이프", "ja"), false);
  assert.equal(nameFitsLanguage("Night Tape", "ja"), false);
  assert.equal(nameFitsLanguage("月夜", "en"), false);
});
