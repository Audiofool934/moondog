import assert from "node:assert/strict";
import test from "node:test";

import { createModels, fauxProvider } from "@earendil-works/pi-ai";

import { listAgentCapabilityDescriptors } from "../../src/core/capability-catalog.mjs";
import { translator } from "../../src/i18n/index.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

function runtimeWith(descriptors) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return new PiAgentRuntime({
    application: { memoryStatus: () => ({ state: "not_persistent" }), agentCapabilityDescriptors: () => descriptors },
    models, model: faux.getModel(), provider: "faux", modelId: "faux-1",
  });
}

test("the mix line reads right for one song, for an all-new set, and in the singular", () => {
  const en = translator("en");
  assert.equal(en("queue.mix", { familiar: 4, returning: 2, new: 6 }), "The mix: 4 you know well, 2 back after a while, 6 new to you.");
  assert.equal(en("queue.mix", { new: 1 }), "The mix: 1 new to you.");
  assert.equal(en("queue.mix", { known_artist: 1 }), "The mix: 1 new from an artist you know.");
  assert.equal(en("queue.mix", { known_artist: 3 }), "The mix: 3 new from artists you know.");
  assert.equal(translator("es")("queue.mix", { returning: 1, new: 1 }), "Según tu historial: 1 que vuelve después de un tiempo, 1 nueva para ti.");
  assert.equal(translator("fr")("queue.mix", { heard: 2, new: 1 }), "D'après votre historique : 2 entendus une ou deux fois, 1 nouveau pour vous.");
  assert.equal(translator("it")("queue.mix", { new: 1 }), "Secondo la tua cronologia: 1 nuovo per te.");
  assert.equal(translator("pt")("queue.mix", { new: 2 }), "Pelo seu histórico: 2 novas para você.");
  assert.equal(translator("de")("queue.mix", { known_artist: 1 }), "Laut deinem Hörverlauf: 1 neu von einem bekannten Künstler.");
  for (const locale of ["en", "es", "fr", "pt", "it", "de", "ja", "ko", "zh", "zh-Hant"]) {
    assert.doesNotMatch(translator(locale)("queue.mix", { familiar: 2 }), /play often|a menudo|souvent|sempre|spesso|oft gehört|よく聴く|자주|常听|常聽/u, locale);
  }
});

test("the prompt keeps plan size, queue brevity and movement dates in one voice", () => {
  const prompt = runtimeWith(listAgentCapabilityDescriptors({})).agent.state.systemPrompt;
  assert.match(prompt, /For a playlist with a stated size, return that many tracks\. When the candidates cannot fill it with good fits, say so and ask before planning fewer\./u);
  assert.match(prompt, /Fewer, better: for a queue or an open pick/u);
  assert.match(prompt, /For a queue, name the anchor and at most one or two highlights inside the short reply\./u);
  assert.match(prompt, /as of the latest stored listening/u);
  assert.match(prompt, /including plays Moondog never stored and songs Moondog itself played or queued/u);
  assert.match(prompt, /they asked to keep it out, and you can lift that if they want it now/u);
  assert.doesNotMatch(prompt, /Return the requested number of tracks|rising now|Give each pick one reason/u);
});

test("only a session with the choice tool is told how to save a choice", () => {
  const without = runtimeWith(listAgentCapabilityDescriptors({}));
  assert.equal(without.agent.state.tools.some((tool) => tool.name === "moondog_taste_choice"), false);
  assert.doesNotMatch(without.agent.state.systemPrompt, /moondog_taste_choice/u);
  assert.match(without.agent.state.systemPrompt, /When no such tool is present, never say a choice was saved\./u);

  const withTool = runtimeWith(listAgentCapabilityDescriptors({ tasteChoicesReady: true }));
  const tool = withTool.agent.state.tools.find((entry) => entry.name === "moondog_taste_choice");
  assert.ok(tool, "the choice tool should be built when choices can be saved");
  assert.match(tool.description, /a choice read from listening behavior \(a skip, a replay, a pause\)/u);
  assert.match(tool.description, /This, this one and this song mean the track; save the artist only when the listener names or means the artist\./u);
  assert.match(tool.description, /name the artist or title, or point to what is playing or was just named/u);
  assert.match(tool.description, /at most 3 choices/u);
  assert.match(tool.description, /so do not say it was saved yourself/u);
});
