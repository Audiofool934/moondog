import assert from "node:assert/strict";
import test from "node:test";
import { replyInOtherLanguage, restateInLanguage } from "../../src/runtime/pi/reply-language.mjs";

test("a reply is in another language only when its prose clearly is", () => {
  assert.equal(replyInOtherLanguage("已把三首 Radiohead 放进队列。", "es"), true);
  assert.equal(replyInOtherLanguage("Listo: tres canciones de Radiohead en la cola.", "es"), false);
  // Chinese names inside an English reply are names, not its language.
  assert.equal(replyInOtherLanguage("1998 - it's on 樹枝孤鳥, the album 伍佰 & China Blue put out that year.", "en"), false);
  // Simplified and Traditional Chinese are one family; a script difference is not restated.
  assert.equal(replyInOtherLanguage("現在播放《被動》。", "zh"), false);
  assert.equal(replyInOtherLanguage("ok", "fr"), false);
});

test("a reply in another language is restated once, and a failed restatement changes nothing", async () => {
  const model = { id: "fixture", reasoning: false };
  const calls = [];
  const models = { completeSimple: async (_model, context) => {
    calls.push(context.messages[0].content);
    return { stopReason: "stop", content: [{ type: "text", text: "Listo: tres canciones de Radiohead en la cola." }] };
  } };
  assert.equal(await restateInLanguage({ models, model, text: "已把三首 Radiohead 放进队列。", locale: "es" }),
    "Listo: tres canciones de Radiohead en la cola.");
  assert.equal(await restateInLanguage({ models, model, text: "Listo, en la cola.", locale: "es" }), null);
  assert.equal(calls.length, 1, "a reply already in the language makes no call");
  const failing = { completeSimple: async () => { throw new Error("offline"); } };
  assert.equal(await restateInLanguage({ models: failing, model, text: "已把三首歌放进队列。", locale: "es" }), null);
});
