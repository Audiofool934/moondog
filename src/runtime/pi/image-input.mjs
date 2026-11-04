import { readFile as readFileFromDisk } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { clampThinkingLevel } from "@earendil-works/pi-ai";

// Images the listener attaches to a message, after Hermes Agent's image routing
// (agent/image_routing.py, image_input_mode "auto"):
//
// - A vision model chosen in Settings describes each image first ("text"): its words go into the
//   message, and the chat model reads them. A chosen auxiliary model wins over the chat model, as in
//   Hermes, so the listener can keep a cheap chat model and a good eye.
// - Otherwise a chat model that takes images gets them as they are ("native").
// - Otherwise nothing can see them, and the message is refused with what to change.
//
// Either way the conversation keeps only text: a short stand-in for a native image, or the vision
// model's description, so a conversation picked up later still knows what was shown.

export const IMAGE_LIMITS = Object.freeze({
  count: 4,
  // Base64 characters of one image, about 6 MB of image; the window scales larger ones down first.
  dataChars: 8_000_000,
  mimeTypes: Object.freeze(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  nameChars: 120,
  // Conversation entries hold at most 8,000 characters, the listener's own words first.
  entryChars: 8_000,
  descriptionChars: 1_600,
});

const VISION_PROMPT = [
  "You describe an image for another model, which answers a music listener in Moondog and cannot see it.",
  "Read any text exactly as written: track lists, artist and album names, playlists, setlists, posters,",
  "streaming app screenshots, chat messages. Name album covers, artists, instruments or places you can recognise,",
  "and say how sure you are when you guess. Describe mood and setting briefly.",
  "Write plain text without a preamble, under 180 words.",
].join(" ");

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

const takesImages = (model) => Array.isArray(model?.input) && model.input.includes("image");

/** The attached images as Pi takes them, checked; an empty list when there are none. */
export function normalizeImages(images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw failure("image_input_invalid", "Images must come as a list.");
  if (images.length > IMAGE_LIMITS.count) throw failure("image_input_too_many", `Attach at most ${IMAGE_LIMITS.count} images to one message.`);
  return images.map((image, index) => {
    const mimeType = String(image?.mimeType ?? "").toLowerCase();
    const data = typeof image?.data === "string" ? image.data.replace(/^data:[^,]*,/u, "") : "";
    if (!IMAGE_LIMITS.mimeTypes.includes(mimeType)) throw failure("image_input_unsupported", "Moondog takes PNG, JPEG, WebP and GIF images.");
    if (!data || data.length > IMAGE_LIMITS.dataChars || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) {
      throw failure("image_input_too_large", "That image is too large or unreadable. Try a smaller one.");
    }
    const name = typeof image?.name === "string" && image.name.trim()
      ? image.name.trim().replace(/[\p{C}[\]]/gu, "").slice(0, IMAGE_LIMITS.nameChars) : `image ${index + 1}`;
    return { type: "image", data, mimeType, name };
  });
}

// Local image paths in a terminal message, as Hermes Agent's gateway finds them: an absolute or ~/
// path ending in an image extension, quoted when it has spaces, or with the "\ " a Finder drag writes.
const EXTENSION_TYPES = Object.freeze({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" });
const QUOTED_PATH = /(["'])((?:~\/|\/)[^"'\n]+?\.(?:png|jpe?g|webp|gif))\1/giu;
const BARE_PATH = /(?<![\w./:])((?:~\/|\/)(?:\\ |[^\s"'])+?\.(?:png|jpe?g|webp|gif))(?=[\s,.;:!?)]*(?:\s|$))/giu;

/** The image files a message names, read from disk; paths that aren't readable images are left as words. */
export async function imagesFromText(text, { readFile = readFileFromDisk, home = os.homedir() } = {}) {
  const found = [];
  const quoted = String(text ?? "").replace(QUOTED_PATH, (_, _quote, file) => { found.push(file); return " "; });
  for (const match of quoted.matchAll(BARE_PATH)) found.push(match[1].replace(/\\ /gu, " "));
  const images = [];
  for (const written of [...new Set(found)].slice(0, IMAGE_LIMITS.count)) {
    const file = written.startsWith("~/") ? path.join(home, written.slice(2)) : written;
    let bytes;
    try { bytes = await readFile(file); } catch { continue; }
    const mimeType = EXTENSION_TYPES[path.extname(file).slice(1).toLowerCase()];
    const data = Buffer.from(bytes).toString("base64");
    if (data.length > IMAGE_LIMITS.dataChars) {
      throw failure("image_input_too_large", `${path.basename(file)} is too large to send. Try a smaller copy or a screenshot of part of it.`);
    }
    images.push({ data, mimeType, name: path.basename(file) });
  }
  return images;
}

const modelLabel = (model) => model?.name ?? model?.id ?? "the vision model";

/** Native, text through a vision model, or a refusal; the vision model is resolved here. */
export async function chooseImageRoute({ models, model, visionChoice }) {
  if (visionChoice?.provider && visionChoice?.model) {
    const vision = models.getModel(visionChoice.provider, visionChoice.model);
    if (!vision || !takesImages(vision)) {
      throw failure("vision_model_unavailable", "The vision model chosen in Settings can't see images any more. Choose another under Model > Auxiliary models > Vision.");
    }
    if (!(await models.checkAuth?.(visionChoice.provider))) {
      throw failure("vision_model_signed_out", `${modelLabel(vision)} needs a sign-in before it can see images. Add its key in Settings > Model.`);
    }
    return { mode: "text", vision };
  }
  if (takesImages(model)) return { mode: "native" };
  throw failure("vision_model_missing",
    `${modelLabel(model)} can't see images. Choose a model that can under Settings > Model > Auxiliary models > Vision, or switch to one that sees.`);
}

async function describe({ models, vision, image, text, signal }) {
  const lightest = clampThinkingLevel(vision, "off");
  const message = await models.completeSimple(vision, {
    systemPrompt: VISION_PROMPT,
    messages: [{ role: "user", timestamp: Date.now(), content: [
      { type: "text", text: text ? `The listener's message, for context: ${text.slice(0, 1_000)}` : "The listener sent this image without words." },
      { type: "image", data: image.data, mimeType: image.mimeType },
    ] }],
  }, { maxTokens: 900, maxRetries: 1, signal, ...(lightest !== "off" ? { reasoning: lightest } : {}) });
  if (!message || message.stopReason === "aborted") throw failure("vision_cancelled", "Stopped describing the image.");
  if (message.stopReason === "error") throw failure("vision_failed", `${modelLabel(vision)} couldn't describe the image. Try again in a moment.`);
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("").replace(/\s+/gu, " ").trim();
}

const clip = (value, limit) => (value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value);

/**
 * The message as the conversation keeps it, and the images the chat model gets with it (only in
 * native mode). Without images it returns the text unchanged.
 */
export async function prepareImageInput({ text, images, models, model, visionChoice, signal }) {
  const attached = normalizeImages(images);
  if (!attached.length) return { text, images: [], mode: null };
  const route = await chooseImageRoute({ models, model, visionChoice });
  const words = String(text ?? "").trim();
  const room = Math.max(400, IMAGE_LIMITS.entryChars - words.length - 40);
  const each = Math.min(IMAGE_LIMITS.descriptionChars, Math.floor(room / attached.length) - 60);
  const notes = [];
  for (const [index, image] of attached.entries()) {
    const label = attached.length > 1 ? `Image ${index + 1} (${image.name})` : `Image (${image.name})`;
    if (route.mode === "native") { notes.push(`[${label} attached]`); continue; }
    const seen = await describe({ models, vision: route.vision, image, text: words, signal });
    notes.push(`[${label}, as ${modelLabel(route.vision)} describes it: ${clip(seen || "nothing it could make out", Math.max(80, each))}]`);
  }
  const kept = [words, notes.join("\n")].filter(Boolean).join("\n\n");
  return {
    text: kept.slice(0, IMAGE_LIMITS.entryChars),
    images: route.mode === "native" ? attached.map(({ type, data, mimeType }) => ({ type, data, mimeType })) : [],
    mode: route.mode,
    ...(route.vision ? { vision: { provider: route.vision.provider, model: route.vision.id, name: modelLabel(route.vision) } } : {}),
  };
}
