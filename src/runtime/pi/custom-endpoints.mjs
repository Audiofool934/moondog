import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { acquirePrivateFileLock, resolveMoondogAuthFile } from "./persistent-credential-store.mjs";

// Endpoints the listener adds by address: any service that speaks OpenAI's Chat Completions or
// Anthropic's Messages, such as DeepSeek, Kimi, GLM, OpenRouter, a company gateway or a model on
// this Mac. Their keys stay in this private file. auth.json is read with a fixed set of providers
// by older Moondogs, which would refuse the whole store with an entry they don't know.
const DOCUMENT_VERSION = 1;
const MAX_ENDPOINTS = 20;
const MAX_MODELS = 500;
const MAX_LISTING_BYTES = 2 * 1024 * 1024;
const PREFIX = "endpoint-";
export const ENDPOINT_FORMATS = Object.freeze(["openai", "anthropic"]);
const apis = { openai: "openai-completions", anthropic: "anthropic-messages" };
const transports = { openai: openAICompletionsApi, anthropic: anthropicMessagesApi };
// Local servers often take no key, but the SDKs under Pi always send one.
const NO_KEY = "moondog-no-key";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const printable = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{C}]/u.test(value);
const plainId = (value, max) => printable(value, max) && !/\s/u.test(value);

function endpointError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "MoondogRuntimeSettingsError";
  error.code = code;
  return error;
}

export const isEndpointProvider = (providerId) => typeof providerId === "string" && providerId.startsWith(PREFIX);

// The address as the listener copied it, down to the base its format's SDK adds paths to: an
// operation's own URL loses that operation, and Anthropic's SDK adds /v1 itself.
export function normalizeBaseUrl(value, format) {
  let url;
  try { url = new URL(String(value ?? "").trim()); } catch { throw endpointError("endpoint_url_invalid", "Enter the endpoint's address, starting with https://."); }
  if (url.username || url.password || url.search || url.hash) {
    throw endpointError("endpoint_url_invalid", "Enter the address without a key, a query or a fragment in it.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw endpointError("endpoint_url_invalid", "Use https://, or http:// only for a server on this Mac.");
  }
  url.pathname = url.pathname.replace(/\/(?:chat\/completions|responses|messages|models)\/?$/u, "").replace(/\/+$/u, "");
  if (format === "anthropic") url.pathname = url.pathname.replace(/\/v1$/u, "");
  return url.href.replace(/\/$/u, "");
}

export function parseModelIds(value) {
  const ids = Array.isArray(value) ? value : String(value ?? "").split(/[\s,]+/u);
  const kept = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
  if (kept.some((id) => !plainId(id, 200))) throw endpointError("endpoint_models_invalid", "A model ID has spaces or characters an endpoint can't take.");
  if (kept.length > MAX_MODELS) throw endpointError("endpoint_models_invalid", `An endpoint can list at most ${MAX_MODELS} models.`);
  return kept;
}

function validEndpoint(value) {
  if (!value || typeof value !== "object" || !isEndpointProvider(value.id) || !plainId(value.id, 60) ||
      !printable(value.name, 60) || !ENDPOINT_FORMATS.includes(value.format) || typeof value.baseUrl !== "string" ||
      (value.key !== undefined && !plainId(value.key, 8192)) || !Array.isArray(value.models)) {
    throw endpointError("endpoint_store_invalid", "Moondog's endpoint file has an entry it can't read. Remove it in Settings, or delete endpoints.json.");
  }
  return { id: value.id, name: value.name, format: value.format, baseUrl: normalizeBaseUrl(value.baseUrl, value.format),
    ...(value.key ? { key: value.key } : {}), models: parseModelIds(value.models) };
}

export function resolveEndpointsFile(environment = process.env) {
  return path.join(path.dirname(resolveMoondogAuthFile(environment)), "endpoints.json");
}

export async function readEndpoints(environment = process.env) {
  let source;
  try {
    source = await readFile(resolveEndpointsFile(environment), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw endpointError("endpoint_store_invalid", "Moondog could not read its endpoints.", error);
  }
  let document;
  try { document = JSON.parse(source); } catch (error) { throw endpointError("endpoint_store_invalid", "Moondog's endpoint file is not valid JSON.", error); }
  if (!document || document.version !== DOCUMENT_VERSION || !Array.isArray(document.endpoints) || document.endpoints.length > MAX_ENDPOINTS) {
    throw endpointError("endpoint_store_invalid", "Moondog's endpoint file uses an unsupported shape.");
  }
  return document.endpoints.map(validEndpoint);
}

// What a window may see of an endpoint: never its key.
export function publicEndpoint({ key, ...shown }) {
  return { ...shown, keySaved: Boolean(key) };
}

async function writeEndpoints(file, endpoints) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: DOCUMENT_VERSION, endpoints }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

const slug = (name) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40) || "endpoint";

// Adds an endpoint, or changes the one with input.id. A key left blank keeps the saved one only while
// the address stays the same, so a key never travels to an address it wasn't entered for. Without
// model IDs, the endpoint is asked for its list.
export async function saveEndpoint(input, environment = process.env, { discover = discoverModels } = {}) {
  const format = ENDPOINT_FORMATS.includes(input?.format) ? input.format : "openai";
  const name = String(input?.name ?? "").trim();
  if (!printable(name, 60)) throw endpointError("endpoint_name_invalid", "Give the endpoint a short name.");
  const baseUrl = normalizeBaseUrl(input?.baseUrl, format);
  const typedKey = String(input?.key ?? "").trim();
  if (typedKey && !plainId(typedKey, 8192)) throw endpointError("endpoint_key_invalid", "The key has spaces or characters a key can't have.");
  const typedModels = parseModelIds(input?.models);

  const file = resolveEndpointsFile(environment);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const release = await acquirePrivateFileLock(file);
  try {
    const endpoints = await readEndpoints(environment);
    const previous = input?.id ? endpoints.find((endpoint) => endpoint.id === input.id) : undefined;
    if (input?.id && !previous) throw endpointError("endpoint_unknown", "That endpoint is no longer saved.");
    if (!previous && endpoints.length >= MAX_ENDPOINTS) throw endpointError("endpoint_limit", `Moondog keeps at most ${MAX_ENDPOINTS} endpoints.`);
    const key = typedKey || (previous && previous.baseUrl === baseUrl && previous.format === format ? previous.key : undefined);
    const models = typedModels.length ? typedModels : await discover({ format, baseUrl, key });
    if (!models.length) throw endpointError("endpoint_models_missing", "The endpoint listed no models. Enter their IDs.");
    let id = previous?.id;
    if (!id) {
      const base = `${PREFIX}${slug(name)}`;
      id = base;
      for (let count = 2; endpoints.some((endpoint) => endpoint.id === id); count++) id = `${base}-${count}`;
    }
    const saved = { id, name, format, baseUrl, ...(key ? { key } : {}), models };
    const next = previous ? endpoints.map((endpoint) => (endpoint.id === id ? saved : endpoint)) : [...endpoints, saved];
    await writeEndpoints(file, next);
    return { endpoint: publicEndpoint(saved), typedModels: typedModels.length > 0 };
  } finally {
    await release();
  }
}

export async function removeEndpoint(id, environment = process.env) {
  const file = resolveEndpointsFile(environment);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const release = await acquirePrivateFileLock(file);
  try {
    const endpoints = await readEndpoints(environment);
    if (!endpoints.some((endpoint) => endpoint.id === id)) return false;
    await writeEndpoints(file, endpoints.filter((endpoint) => endpoint.id !== id));
    return true;
  } finally {
    await release();
  }
}

// The model list an endpoint publishes, in its order: OpenAI's /models or Anthropic's /v1/models.
// Its body and errors never reach the window; only whether it worked.
export async function discoverModels({ format, baseUrl, key }, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const url = format === "anthropic" ? `${baseUrl}/v1/models?limit=1000` : `${baseUrl}/models`;
  const headers = format === "anthropic"
    ? { Accept: "application/json", "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) }
    : { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  let ids;
  try {
    const response = await fetchImpl(url, { headers, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok || Number(response.headers.get("content-length")) > MAX_LISTING_BYTES) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_LISTING_BYTES) throw new Error("oversized");
    const document = JSON.parse(text);
    ids = (Array.isArray(document?.data) ? document.data : Array.isArray(document?.models) ? document.models : [])
      .map((entry) => (typeof entry === "string" ? entry : entry?.id)).filter((id) => typeof id === "string");
  } catch (error) {
    throw endpointError("endpoint_models_unavailable", "The endpoint didn't list its models. Check the address and key, or enter the model IDs.", error);
  }
  return parseModelIds(ids.slice(0, MAX_MODELS));
}

// A model Pi already knows by the same ID, such as deepseek-chat or anthropic/claude-sonnet-5, keeps
// its name and limits; through the same kind of API it also keeps its thinking levels and request
// details. Any other model is plain text without thinking, which every compatible server takes.
let known;
function knownModels() {
  if (!known) {
    known = new Map();
    for (const model of builtinModels().getModels()) {
      const list = known.get(model.id) ?? [];
      list.push(model);
      known.set(model.id, list);
    }
  }
  return known;
}

function endpointModel(endpoint, id) {
  const api = apis[endpoint.format];
  const matches = knownModels().get(id) ?? [];
  const same = matches.find((model) => model.api === api);
  const match = same ?? matches[0];
  return {
    id, name: match?.name ?? id, provider: endpoint.id, api, baseUrl: endpoint.baseUrl,
    reasoning: same?.reasoning === true,
    input: match?.input ? [...match.input] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: match?.contextWindow ?? 128_000,
    maxTokens: match?.maxTokens ?? 8192,
    ...(same?.thinkingLevelMap ? { thinkingLevelMap: structuredClone(same.thinkingLevelMap) } : {}),
    ...(same?.compat ? { compat: structuredClone(same.compat) } : {}),
  };
}

export function addEndpoints(models, endpoints = []) {
  for (const endpoint of endpoints) {
    models.setProvider(createProvider({
      id: endpoint.id, name: endpoint.name, baseUrl: endpoint.baseUrl,
      models: endpoint.models.map((id) => endpointModel(endpoint, id)),
      auth: { apiKey: { name: `${endpoint.name} key`, resolve: async () => ({ auth: { apiKey: endpoint.key ?? NO_KEY }, source: "stored credential" }) } },
      api: transports[endpoint.format](),
    }));
  }
  return models;
}
