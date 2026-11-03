// The host chooses the language of each reply (src/i18n messageLocale), and the model is told
// it. Some models still drift, for example into Chinese on a Spanish request. A reply clearly in
// another language is restated once by the same model, without tools, in the chosen language.
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { LOCALES, messageLocale } from "../../i18n/index.mjs";

const CJK_LOCALES = new Set(["zh", "zh-Hant", "ja", "ko"]);
const sameFamily = (left, right) => left === right || (left.startsWith("zh") && right.startsWith("zh"));

/** Whether a reply is clearly in another language than the one chosen for it. */
export function replyInOtherLanguage(text, locale) {
  if (typeof text !== "string" || !text.trim() || !LOCALES[locale]) return false;
  // Quoted and bracketed names travel across languages; in a Latin-script reply, so do Chinese
  // characters (song, album and artist names).
  const prose = text.replace(/"(?:[^"\\]|\\.)*"|“[^”]*”|«[^»]*»|「[^」]*」|『[^』]*』|《[^》]*》|\*\*[^*]*\*\*/gu, " ");
  // A Chinese character stands for about one word. Fewer of them than Latin words are names;
  // more of them are the reply itself.
  const han = prose.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latin = prose.match(/\p{Script=Latin}+/gu)?.length ?? 0;
  const names = !CJK_LOCALES.has(locale) && latin > han;
  const read = messageLocale(names ? prose.replace(/\p{Script=Han}+/gu, " ") : prose, locale);
  return !sameFamily(read, locale);
}

const SYSTEM_PROMPT = "You restate a music assistant's reply in another language. Keep its meaning, facts, tone, line breaks and Markdown. Keep names of songs, albums, artists and devices exactly as written. Return only the restated reply.";

/** The reply restated in the chosen language, or null when it needs none or the call fails. */
export async function restateInLanguage({ models, model, text, locale, signal, maxTokens = 2_000 }) {
  if (!replyInOtherLanguage(text, locale) || typeof models?.completeSimple !== "function" || !model) return null;
  const lightest = clampThinkingLevel(model, "off");
  try {
    const message = await models.completeSimple(model, {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Restate this reply in ${LOCALES[locale].name} (${locale}).\n\n${text}`, timestamp: Date.now() }],
    }, { maxTokens, maxRetries: 0, signal, ...(lightest !== "off" ? { reasoning: lightest } : {}) });
    // Only a restatement that ended on its own replaces the reply; one cut at the token limit would lose its end.
    if (!message || message.stopReason !== "stop") return null;
    const restated = (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("").trim();
    // A restatement still in the wrong language is no better than the reply it replaces.
    return restated && !replyInOtherLanguage(restated, locale) ? restated : null;
  } catch {
    return null;
  }
}
