import assert from "node:assert/strict";
import test from "node:test";

import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";

import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";
import { IMAGE_LIMITS, imagesFromText, normalizeImages, prepareImageInput } from "../../src/runtime/pi/image-input.mjs";

test("a terminal message's image paths become images, however the path is written", async () => {
  const files = { "/tmp/a.png": "A", "/Users/example/Desktop/My Cover.JPG": "B", "/Users/example/shot.webp": "C" };
  const readFile = async (file) => { if (!(file in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return Buffer.from(files[file]); };
  const images = await imagesFromText(
    "What is /tmp/a.png? And \"/Users/example/Desktop/My Cover.JPG\", ~/shot.webp, /tmp/missing.png and https://example.com/x.png",
    { readFile, home: "/Users/example" });
  assert.deepEqual(images.map((entry) => [entry.name, entry.mimeType, Buffer.from(entry.data, "base64").toString()]),
    [["My Cover.JPG", "image/jpeg", "B"], ["a.png", "image/png", "A"], ["shot.webp", "image/webp", "C"]]);
  // A Finder drag escapes spaces.
  const dragged = await imagesFromText("/Users/example/Desktop/My\\ Cover.JPG", { readFile, home: "/Users/example" });
  assert.equal(dragged[0].name, "My Cover.JPG");
  assert.deepEqual(await imagesFromText("no paths here", { readFile }), []);
});

const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const image = (name = "cover.png") => ({ data: pixel, mimeType: "image/png", name });

function fakeModels({ signedIn = true, reply = "A record sleeve: Big Thief, Double Infinity." } = {}) {
  const calls = [];
  const catalog = {
    "anthropic/claude-opus-5-5": { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", input: ["text", "image"], reasoning: true },
    "deepseek/deepseek-v4-pro": { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", input: ["text"], reasoning: true },
  };
  return {
    calls,
    getModel: (provider, id) => catalog[`${provider}/${id}`],
    checkAuth: async () => signedIn,
    completeSimple: async (model, context, options) => {
      calls.push({ model: model.id, context, options });
      return { stopReason: "stop", content: [{ type: "text", text: reply }] };
    },
  };
}

test("a chat model that sees gets the images, and the conversation keeps a stand-in", async () => {
  const models = fakeModels();
  const prepared = await prepareImageInput({ text: "What record is this?", images: [image()], models,
    model: models.getModel("anthropic", "claude-opus-5-5"), visionChoice: null });
  assert.equal(prepared.mode, "native");
  assert.equal(prepared.text, "What record is this?\n\n[Image (cover.png) attached]");
  assert.deepEqual(prepared.images, [{ type: "image", data: pixel, mimeType: "image/png" }]);
  assert.equal(models.calls.length, 0);
});

test("a vision model chosen in Settings describes the images, even for a chat model that sees", async () => {
  const models = fakeModels();
  const prepared = await prepareImageInput({ text: "", images: [image("a.png"), image("b.png")], models,
    model: models.getModel("deepseek", "deepseek-v4-pro"), visionChoice: { provider: "anthropic", model: "claude-opus-5-5" } });
  assert.equal(prepared.mode, "text");
  assert.deepEqual(prepared.images, []);
  assert.match(prepared.text, /^\[Image 1 \(a\.png\), as Claude Opus 5\.5 describes it: A record sleeve: Big Thief, Double Infinity\.\]\n\[Image 2 \(b\.png\)/u);
  assert.equal(models.calls.length, 2);
  assert.deepEqual(models.calls[0].context.messages[0].content.map((part) => part.type), ["text", "image"]);
  assert.equal(prepared.vision.model, "claude-opus-5-5");
});

test("images with nothing to see them are refused with what to change, and bad images never go out", async () => {
  const models = fakeModels();
  const textOnly = models.getModel("deepseek", "deepseek-v4-pro");
  await assert.rejects(prepareImageInput({ text: "hi", images: [image()], models, model: textOnly, visionChoice: null }),
    { code: "vision_model_missing", message: /Auxiliary models > Vision/u });
  await assert.rejects(prepareImageInput({ text: "hi", images: [image()], models, model: textOnly, visionChoice: { provider: "deepseek", model: "deepseek-v4-pro" } }),
    { code: "vision_model_unavailable" });
  await assert.rejects(prepareImageInput({ text: "hi", images: [image()], models: fakeModels({ signedIn: false }), model: textOnly,
    visionChoice: { provider: "anthropic", model: "claude-opus-5-5" } }), { code: "vision_model_signed_out" });
  assert.throws(() => normalizeImages([{ data: pixel, mimeType: "image/svg+xml" }]), { code: "image_input_unsupported" });
  assert.throws(() => normalizeImages([{ data: "not base64!", mimeType: "image/png" }]), { code: "image_input_too_large" });
  assert.throws(() => normalizeImages(Array.from({ length: IMAGE_LIMITS.count + 1 }, () => image())), { code: "image_input_too_many" });
  // Without images the message is untouched.
  assert.deepEqual(await prepareImageInput({ text: "hi", images: [], models, model: textOnly }), { text: "hi", images: [], mode: null });
});

function fauxRuntime({ visionChoice = null } = {}) {
  const faux = fauxProvider({ models: [
    { id: "sees", name: "Sees", input: ["text", "image"] },
    { id: "blind", name: "Blind", input: ["text"] },
  ] });
  const models = createModels();
  models.setProvider(faux.provider);
  const application = new MoondogApplication({ importsRoot: "/tmp/moondog-image-no-import" });
  return { faux, application, make: (id) => new PiAgentRuntime({ application, models, model: faux.getModel(id), provider: "faux", modelId: id,
    ...(visionChoice ? { visionChoice: async () => visionChoice } : {}) }) };
}
const lastUser = (context) => context.messages.filter((message) => message.role === "user").at(-1);

test("the agent sends a seeing chat model the image itself", async () => {
  const { faux, application, make } = fauxRuntime();
  let seen;
  faux.setResponses([(context) => { seen = lastUser(context).content; return fauxAssistantMessage([fauxText("That's Double Infinity.")]); }]);
  const result = await make("sees").prompt("What record is this?", { images: [image()] });
  assert.equal(result.text, "That's Double Infinity.");
  assert.deepEqual(seen.map((part) => part.type), ["text", "image"]);
  assert.match(seen[0].text, /What record is this\?\n\n\[Image \(cover\.png\) attached\]/u);
  application.close();
});

test("the agent hands a blind chat model the vision model's words, and refuses when nothing can see", async () => {
  const { faux, application, make } = fauxRuntime({ visionChoice: { provider: "faux", model: "sees" } });
  let seen;
  faux.setResponses([
    fauxAssistantMessage([fauxText("A sleeve reading Big Thief, Double Infinity.")]),
    (context) => { seen = lastUser(context).content; return fauxAssistantMessage([fauxText("Big Thief's Double Infinity.")]); },
  ]);
  const ready = [];
  await make("blind").prompt("What record is this?", { images: [image()], onImagesReady: (info) => ready.push(info.mode) });
  assert.deepEqual(ready, ["text"]);
  assert.deepEqual(seen.map((part) => part.type), ["text"]);
  assert.match(seen[0].text, /as Sees describes it: A sleeve reading Big Thief, Double Infinity\./u);

  const nothing = fauxRuntime();
  const runtime = nothing.make("blind");
  await assert.rejects(runtime.prompt("What is this?", { images: [image()] }), { code: "vision_model_missing" });
  // A refused message leaves the agent free for the next one.
  nothing.faux.setResponses([fauxAssistantMessage([fauxText("Hello.")])]);
  assert.equal((await runtime.prompt("Hello")).text, "Hello.");
  application.close();
  nothing.application.close();
});

test("descriptions are clipped so the kept message fits a conversation entry", async () => {
  const models = fakeModels({ reply: "word ".repeat(2_000) });
  const prepared = await prepareImageInput({ text: "x".repeat(6_000), images: [image(), image(), image(), image()], models,
    model: models.getModel("deepseek", "deepseek-v4-pro"), visionChoice: { provider: "anthropic", model: "claude-opus-5-5" } });
  assert.ok(prepared.text.length <= IMAGE_LIMITS.entryChars, `kept ${prepared.text.length} characters`);
  assert.ok(prepared.text.startsWith("x".repeat(6_000)));
});
