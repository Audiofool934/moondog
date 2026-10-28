import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { resolveMoondogAuthFile } from "./persistent-credential-store.mjs";

// The models the listener keeps at hand: the window's model menu shows these, flat, in this order.
// Which one answers by default stays in settings.json, which older Moondogs read with a fixed shape,
// so the list lives in its own file beside it.
const LIST_VERSION = 1;
const MAX_MODELS = 40;
const printable = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{C}\s]/u.test(value);

function listError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "MoondogRuntimeSettingsError";
  error.code = "model_list_invalid";
  return error;
}

export const sameModel = (left, right) => Boolean(left && right) && left.provider === right.provider && left.model === right.model;

export function normalizeModelList(value) {
  if (!Array.isArray(value)) throw listError("Moondog's model list must be a list.");
  const models = [];
  for (const entry of value) {
    const provider = typeof entry?.provider === "string" ? entry.provider.trim().toLowerCase() : "";
    const model = typeof entry?.model === "string" ? entry.model.trim() : "";
    if (!printable(provider, 80) || !printable(model, 200)) throw listError("Moondog's model list has an entry without a provider and model.");
    if (!models.some((kept) => sameModel(kept, { provider, model }))) models.push({ provider, model });
  }
  if (models.length > MAX_MODELS) throw listError(`Moondog keeps at most ${MAX_MODELS} models in its list.`);
  return models;
}

export function resolveModelListFile(environment = process.env) {
  return path.join(path.dirname(resolveMoondogAuthFile(environment)), "models.json");
}

// Undefined until the listener first changes the list; the window then starts it from the default.
export async function readModelList(environment = process.env) {
  let source;
  try {
    source = await readFile(resolveModelListFile(environment), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw listError("Moondog could not read its model list.", error);
  }
  let document;
  try {
    document = JSON.parse(source);
  } catch (error) {
    throw listError("Moondog's model list is not valid JSON.", error);
  }
  if (!document || typeof document !== "object" || document.version !== LIST_VERSION) {
    throw listError("Moondog's model list uses an unsupported shape.");
  }
  return normalizeModelList(document.models);
}

export async function writeModelList(models, environment = process.env) {
  const normalized = normalizeModelList(models);
  const file = resolveModelListFile(environment);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Another Moondog may read the list at any moment, so it never sees half a file.
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: LIST_VERSION, models: normalized }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return normalized;
}

// The model each conversation was given in the window's menu, by conversation id, so a conversation
// keeps its own model across launches; every other one answers with the default. The oldest go first
// past a few hundred.
const MAX_CONVERSATIONS = 500;
const resolveConversationModelsFile = (environment) => path.join(path.dirname(resolveMoondogAuthFile(environment)), "conversation-models.json");

export async function readConversationModels(environment = process.env) {
  let document;
  try {
    document = JSON.parse(await readFile(resolveConversationModelsFile(environment), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw listError("Moondog could not read the models chosen for conversations.", error);
  }
  if (!document || document.version !== LIST_VERSION || !document.conversations || typeof document.conversations !== "object") {
    throw listError("Moondog's conversation models use an unsupported shape.");
  }
  const kept = {};
  for (const [session, value] of Object.entries(document.conversations).slice(-MAX_CONVERSATIONS)) {
    if (!printable(session, 100)) continue;
    const [entry] = normalizeModelList([value]);
    kept[session] = { ...entry, ...(typeof value.effort === "string" && printable(value.effort, 20) ? { effort: value.effort } : {}) };
  }
  return kept;
}

// One change at a time, so two quick choices never lose either.
let writing = Promise.resolve();
export function writeConversationModel(session, selection, environment = process.env) {
  const next = writing.then(async () => {
    const saved = await readConversationModels(environment).catch(() => ({}));
    delete saved[session];
    if (selection) saved[session] = { provider: selection.provider, model: selection.model, ...(selection.effort ? { effort: selection.effort } : {}) };
    const conversations = Object.fromEntries(Object.entries(saved).slice(-MAX_CONVERSATIONS));
    const file = resolveConversationModelsFile(environment);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: LIST_VERSION, conversations }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  });
  writing = next.catch(() => {});
  return next;
}
