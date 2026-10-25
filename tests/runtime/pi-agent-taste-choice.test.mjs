import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

import { createListeningProfileDomainServices } from "../../src/core/listening-profile-domain-services.mjs";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { openListeningHistoryStore } from "../../src/profile/listening-history-store.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

const subjectId = "11111111-1111-4111-8111-111111111111";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "moondog-taste-choice-"));
  const store = await openListeningHistoryStore({ databasePath: path.join(root, "history.sqlite") });
  const domainServices = createListeningProfileDomainServices({ listeningHistoryStore: store, subjectId });
  const application = new MoondogApplication({ domainServices, importsRoot: path.join(root, "no-imports") });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({ application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  t.after(async () => { await application.close(); await rm(root, { recursive: true, force: true }); });
  return { store, domainServices, faux, runtime };
}

const choose = (parameters) => fauxAssistantMessage([fauxToolCall("moondog_taste_choice", parameters)], { stopReason: "toolUse" });
const toolResult = (context) => context.messages.findLast((message) => message.role === "toolResult" && message.toolName === "moondog_taste_choice");
const duet = { title: "Fictional Duet", artist_credit: "Future feat. Drake" };

test("a choice the listener states in chat is saved at once, kept out of play, and receipted", async (t) => {
  const { store, domainServices, faux, runtime } = await fixture(t);
  faux.setResponses([
    (context) => {
      assert.match(JSON.stringify(context.messages), /call moondog_taste_choice with their exact words/u);
      return choose({ subject: "artist", artist: "Drake", stance: "avoid", source_text: "never play Drake again" });
    },
    (context) => {
      assert.deepEqual(JSON.parse(toolResult(context).content[0].text), { state: "active", stance: "avoid", subject: "artist", name: "Drake" });
      return fauxAssistantMessage([fauxText("Got it.")]);
    },
  ]);
  const saved = await runtime.prompt("Please never play Drake again.");
  assert.equal(saved.text, "Got it.\n\nSaved: I'll keep Drake out of what I play and suggest. Tell me any time to change it.");
  assert.equal(domainServices.filterDiscoveryTracks([duet]).length, 0, "the Avoid applies on the next play");

  faux.setResponses([
    choose({ subject: "artist", artist: "Drake", stance: "retract", source_text: "Drake is fine again" }),
    fauxAssistantMessage([fauxText("Done.")]),
  ]);
  const undone = await runtime.prompt("Actually, Drake is fine again.");
  assert.match(undone.text, /Undone: your earlier choice about Drake\.$/u);
  assert.equal(domainServices.filterDiscoveryTracks([duet]).length, 1);
  assert.equal(store.listListenerCorrections({ subjectId }).length, 0);
});

test("a choice the listener did not state, or a bare name, is refused and nothing is saved", async (t) => {
  const { store, faux, runtime } = await fixture(t);
  faux.setResponses([
    choose({ subject: "artist", artist: "Nick Drake", stance: "like", source_text: "I love Nick Drake" }),
    (context) => {
      const result = toolResult(context);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /taste_choice_quote_required/u);
      return choose({ subject: "track", artist: "Nick Drake", stance: "like", source_text: "Pink Moon" });
    },
    (context) => {
      assert.match(toolResult(context).content[0].text, /taste_choice_title_required/u);
      // The listener's words, but only the name: no choice is stated.
      return choose({ subject: "track", artist: "Nick Drake", title: "Pink Moon", stance: "like", source_text: "Pink Moon" });
    },
    (context) => {
      assert.match(toolResult(context).content[0].text, /taste_choice_statement_required/u);
      return fauxAssistantMessage([fauxText("Here is something close to Pink Moon.")]);
    },
  ]);
  const reply = await runtime.prompt("Play something like Pink Moon.");
  assert.equal(reply.text, "Here is something close to Pink Moon.");
  assert.equal(store.listListenerCorrections({ subjectId }).length, 0);
});

const refusal = (context) => toolResult(context).content[0].text;

test("a choice is bound to the listener's words: one word, an unrelated quote or a fourth choice saves nothing", async (t) => {
  const { store, faux, runtime } = await fixture(t);
  // Each of these quotes is in the message, but none states a choice about the artist.
  faux.setResponses([
    choose({ subject: "artist", artist: "Radiohead", stance: "avoid", source_text: "e" }),
    (context) => {
      assert.match(refusal(context), /taste_choice_quote_too_short/u);
      return choose({ subject: "artist", artist: "Nick Drake", stance: "avoid", source_text: "like" });
    },
    (context) => {
      assert.match(refusal(context), /taste_choice_quote_too_short/u);
      return choose({ subject: "artist", artist: "Bjork", stance: "avoid", source_text: "Play" });
    },
    (context) => {
      assert.match(refusal(context), /taste_choice_quote_too_short/u);
      return choose({ subject: "artist", artist: "Bjork", stance: "avoid", source_text: "Play something like" });
    },
    (context) => {
      assert.match(refusal(context), /taste_choice_quote_unbound/u);
      return choose({ subject: "artist", artist: "Bjork", stance: "retract", source_text: "Play something like" });
    },
    (context) => {
      assert.match(refusal(context), /taste_choice_quote_unbound/u);
      return fauxAssistantMessage([fauxText("Here is something close to Pink Moon.")]);
    },
  ]);
  assert.equal((await runtime.prompt("Play something like Pink Moon.")).text, "Here is something close to Pink Moon.");
  assert.equal(store.listListenerCorrections({ subjectId }).length, 0);

  const message = "I love Nick Drake, Vashti Bunyan, Linda Perhacs and Bert Jansch";
  faux.setResponses([
    choose({ subject: "artist", artist: "Nick Drake", stance: "like", source_text: "I love Nick Drake" }),
    choose({ subject: "artist", artist: "Vashti Bunyan", stance: "like", source_text: message }),
    choose({ subject: "artist", artist: "Linda Perhacs", stance: "like", source_text: message }),
    choose({ subject: "artist", artist: "Bert Jansch", stance: "like", source_text: message }),
    (context) => {
      assert.match(refusal(context), /taste_choice_turn_limit/u);
      return fauxAssistantMessage([fauxText("Saved three of them.")]);
    },
  ]);
  await runtime.prompt(message);
  assert.deepEqual(store.listListenerCorrections({ subjectId }).map((record) => record.label).sort(),
    ["Linda Perhacs", "Nick Drake", "Vashti Bunyan"]);
});

test("a choice about what is playing can point at it in the listener's words", async (t) => {
  const { domainServices, faux, runtime } = await fixture(t);
  faux.setResponses([
    choose({ subject: "track", artist: "Mira Vale", title: "Night Ferry", stance: "avoid", source_text: "never play this again" }),
    (context) => {
      assert.equal(toolResult(context).isError, false, refusal(context));
      return fauxAssistantMessage([fauxText("Okay.")]);
    },
  ]);
  const reply = await runtime.prompt("Ugh, never play this again.");
  assert.match(reply.text, /Saved: I'll keep "Night Ferry" by Mira Vale out/u);
  assert.equal(domainServices.filterDiscoveryTracks([{ title: "Night Ferry", artist_credit: "Mira Vale" }]).length, 0);

  faux.setResponses([
    choose({ subject: "artist", artist: "周杰伦", stance: "like", source_text: "我很喜欢这个歌手" }),
    (context) => {
      assert.equal(toolResult(context).isError, false, refusal(context));
      return fauxAssistantMessage([fauxText("好的。")]);
    },
  ]);
  assert.match((await runtime.prompt("我很喜欢这个歌手")).text, /周杰伦/u);
});

test("a choice saved in a cancelled or interrupted turn keeps its line", async (t) => {
  const { faux, runtime } = await fixture(t);
  faux.setResponses([
    choose({ subject: "artist", artist: "Drake", stance: "avoid", source_text: "never play Drake again" }),
    () => { runtime.abort(); return fauxAssistantMessage([fauxText("Also putting on")]); },
  ]);
  const cancelled = await runtime.prompt("never play Drake again, and put on something else");
  assert.equal(cancelled.status, "aborted");
  assert.match(cancelled.text, /Saved: I'll keep Drake out of what I play and suggest\./u);

  faux.setResponses([
    choose({ subject: "artist", artist: "Mira Vale", stance: "like", source_text: "I love Mira Vale" }),
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "PRIVATE_MODEL_FAILURE" }),
  ]);
  const interrupted = await runtime.prompt("I love Mira Vale");
  assert.equal(interrupted.status, "interrupted");
  assert.match(interrupted.text, /Saved: you like Mira Vale\./u);
  assert.doesNotMatch(interrupted.text, /PRIVATE_/u);
});

test("the application hears the listener's two messages before this one", async (t) => {
  const { faux, runtime } = await fixture(t);
  const application = runtime.application;
  const seen = [];
  const beginPrompt = application.beginPrompt.bind(application);
  application.beginPrompt = (input) => { seen.push(input.recentTexts); return beginPrompt(input); };
  for (const text of ["Tell me about Pink Moon by Nick Drake", "Is it sad?", "How long is it?", "Play it"]) {
    faux.setResponses([fauxAssistantMessage([fauxText("Sure.")])]);
    await runtime.prompt(text);
  }
  assert.deepEqual(seen.at(-1), ["Is it sad?", "How long is it?"]);
  assert.deepEqual(seen[0], []);
});
