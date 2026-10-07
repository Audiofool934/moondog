import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createPiModels, listPiModels, listPiProviders } from "./model-catalog.mjs";
import { acquirePrivateFileLock, resolveMoondogAuthFile } from "./persistent-credential-store.mjs";
import { supportedPiProviderIds } from "./provider-registry.mjs";

export const PI_CATALOG_VERSION = "1.0.1";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 2000;
const FRESH_MS = 4 * 60 * 60 * 1000;
const plain = value => value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const printable = (value, max = 200) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{C}\n\r]/u.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 100_000_000;
const rates = ["input", "output", "cacheRead", "cacheWrite"];
const compatKeys = {
  "openai-completions": "supportsStore supportsDeveloperRole supportsReasoningEffort supportsUsageInStreaming supportsFinishReason requiresToolResultName requiresAssistantAfterToolResult requiresThinkingAsText requiresReasoningContentOnAssistantMessages zaiToolStream supportsOpenAIGrammarTools supportsStrictMode supportsLongCacheRetention",
  "openai-responses": "supportsDeveloperRole supportsLongCacheRetention supportsStrictMode supportsOpenAIGrammarTools supportsAdditionalTools supportsToolSearch supportsExplicitPromptCacheMode",
  "anthropic-messages": "supportsEagerToolInputStreaming supportsLongCacheRetention supportsCacheControlOnTools supportsTemperature forceAdaptiveThinking allowEmptySignature supportsStrictTools supportsToolReferences",
};
compatKeys["openai-codex-responses"] = compatKeys["openai-responses"];
const compatEnums = {
  maxTokensField: ["max_tokens", "max_completion_tokens"], cacheControlFormat: ["anthropic"],
  thinkingFormat: ["openai", "openrouter", "deepseek", "together", "zai", "qwen", "qwen-chat-template", "string-thinking", "ant-ling"],
};
const failure = message => new Error(`Model catalog: ${message}`);

function projectModel(value, id, native) {
  const originals = native.getModels();
  const baseline = originals.find(model => model.id === id);
  if (!plain(value) || value.id !== id || !printable(id) || !/^[A-Za-z0-9~][A-Za-z0-9._:/@+~-]*$/u.test(id) ||
      value.provider !== native.id || value.type !== undefined && value.type !== "chat" ||
      !originals.some(model => model.api === value.api) || !printable(value.name) || typeof value.reasoning !== "boolean" ||
      !Array.isArray(value.input) || !value.input.includes("text") || value.input.length > 2 || value.input.some(input => !["text", "image"].includes(input)) ||
      !positive(value.contextWindow) || !positive(value.maxTokens) || !plain(value.cost) ||
      rates.some(key => !Number.isFinite(value.cost[key]) || value.cost[key] < 0 || value.cost[key] > 1_000_000)) return null;
  const cost = Object.fromEntries(rates.map(key => [key, value.cost[key]]));
  if (value.cost.tiers !== undefined) {
    if (!Array.isArray(value.cost.tiers) || value.cost.tiers.length > 10) return null;
    cost.tiers = [];
    for (const tier of value.cost.tiers) {
      if (!plain(tier) || !positive(tier.inputTokensAbove) || rates.some(key => !Number.isFinite(tier[key]) || tier[key] < 0 || tier[key] > 1_000_000) ||
          tier.inputTokensAbove <= (cost.tiers.at(-1)?.inputTokensAbove ?? 0)) return null;
      cost.tiers.push({ inputTokensAbove: tier.inputTokensAbove, ...Object.fromEntries(rates.map(key => [key, tier[key]])) });
    }
  }
  const compat = { ...baseline?.compat };
  if (value.compat !== undefined && !plain(value.compat)) return null;
  for (const key of (compatKeys[value.api] ?? "").split(" ").filter(Boolean)) {
    if (value.compat?.[key] !== undefined) {
      if (typeof value.compat[key] !== "boolean") return null;
      compat[key] = value.compat[key];
    }
  }
  if (value.api === "openai-completions") for (const [key, allowed] of Object.entries(compatEnums)) {
    if (value.compat?.[key] !== undefined) {
      if (!allowed.includes(value.compat[key])) return null;
      compat[key] = value.compat[key];
    }
  }
  let thinkingLevelMap = baseline?.thinkingLevelMap;
  if (value.thinkingLevelMap !== undefined) {
    if (!plain(value.thinkingLevelMap)) return null;
    thinkingLevelMap = {};
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      const mapped = value.thinkingLevelMap[level];
      if (mapped !== undefined) {
        if (mapped !== null && !printable(mapped, 40)) return null;
        thinkingLevelMap[level] = mapped;
      }
    }
  }
  // Remote metadata cannot choose credential destinations, headers or transports.
  return { ...baseline, id, name: value.name, provider: native.id, api: value.api,
    baseUrl: baseline?.baseUrl ?? native.baseUrl ?? originals.find(model => model.api === value.api)?.baseUrl,
    reasoning: value.reasoning, input: [...new Set(value.input)], contextWindow: value.contextWindow, maxTokens: value.maxTokens,
    cost, compat, ...(thinkingLevelMap ? { thinkingLevelMap } : {}) };
}

function projectDocument(document, native) {
  if (!plain(document) || Object.keys(document).length > MAX_MODELS) throw failure("invalid or oversized model list.");
  const models = []; let skipped = 0;
  for (const [id, value] of Object.entries(document)) {
    const model = projectModel(value, id, native);
    if (model) models.push(model); else skipped++;
  }
  if (!models.length) throw failure("no compatible chat models in the response.");
  return { models, skipped };
}

function mergeKnownModels(...collections) {
  const merged = new Map(collections.flatMap(models => models ?? []).map(model => [model.id, model]));
  if (merged.size > MAX_MODELS) throw failure("too many retained models.");
  return [...merged.values()];
}

function mergeRecords(previous, next) {
  if (!previous) return next;
  if (!next) return previous;
  const [older, newer] = previous.checkedAt > next.checkedAt ? [next, previous] : [previous, next];
  return { ...newer, models: mergeKnownModels(older.models, newer.models) };
}

async function abortable(promise, signal) {
  // The caller already started the work. Observe it even when the deadline
  // passed first, so its later failure cannot become an unhandled rejection.
  promise.catch(() => {});
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true }); });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

async function responseDocument(response, signal) {
  if (Number(response.headers.get("content-length")) > MAX_BYTES || !response.body) throw failure("oversized or empty response.");
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw failure("response exceeds size limit.");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { void reader.cancel().catch(() => {}); }
}

async function readCache(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw failure("invalid cache file.");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw failure("oversized cache.");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await handle.close(); }
}

async function writeCache(root, file, document, signal) {
  const serialized = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw failure("cache exceeds size limit.");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory()) throw failure("cache directory must not be a symlink.");
  const temp = path.join(root, `.catalog-${randomUUID()}.tmp`);
  let handle;
  try {
    signal.throwIfAborted();
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(serialized, "utf8"); await handle.close(); handle = null;
    signal.throwIfAborted();
    await rename(temp, file);
  } finally { await handle?.close(); await unlink(temp).catch(() => {}); }
}

export class PublicPiModelCatalog {
  constructor({ environment = process.env, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 4000 } = {}) {
    this.root = path.join(path.dirname(resolveMoondogAuthFile(environment)), "model-catalog");
    this.fetch = fetchImpl; this.now = now; this.timeoutMs = timeoutMs;
    this.baseline = createPiModels(); this.records = new Map(); this.pending = new Set();
    this.snapshot = this.baseline;
    this.ready = this.restore();
  }

  file(id) { return path.join(this.root, `${id}.json`); }
  publish() { this.snapshot = this.createModels(); }
  createModels(options) { return createPiModels({ ...options, catalogModels: new Map([...this.records].map(([id, record]) => [id, record.models])) }); }
  providers() { return listPiProviders(this.snapshot); }
  models(id) {
    const record = this.records.get(id);
    return listPiModels(id, this.snapshot).map(model => ({ ...model,
      ...(record && !record.currentIds.includes(model.id) && !model.name.includes("legacy alias") ? { catalogNote: "retained; not in latest catalog" } : {}),
    }));
  }

  async readRecord(id) {
    try {
      const value = await readCache(this.file(id));
      if (!plain(value) || value.version !== 1 || value.piVersion !== PI_CATALOG_VERSION || value.provider !== id ||
          !Number.isSafeInteger(value.checkedAt) || value.checkedAt < 0 || value.checkedAt > this.now() + 300_000 ||
          !Array.isArray(value.models) || value.models.length > MAX_MODELS || !Array.isArray(value.currentIds) || value.currentIds.length > MAX_MODELS) return;
      const projection = projectDocument(Object.fromEntries(value.models.map(model => [model.id, model])), this.baseline.getProvider(id));
      const ids = new Set(projection.models.map(model => model.id));
      if (projection.skipped || value.currentIds.some(id => !ids.has(id))) return;
      return { version: 1, piVersion: PI_CATALOG_VERSION, provider: id, checkedAt: value.checkedAt,
        models: projection.models, currentIds: value.currentIds,
        ...(printable(value.etag, 300) ? { etag: value.etag } : {}) };
    } catch { /* A missing or corrupt metadata cache is optional at startup. */ }
  }

  async restore() {
    try { if (!(await lstat(this.root)).isDirectory()) return; } catch { return; }
    await Promise.all(supportedPiProviderIds.map(async id => {
      const latest = await this.readRecord(id);
      if (latest) {
        try { this.records.set(id, mergeRecords(this.records.get(id), latest)); }
        catch { /* Retention limits cannot make an existing snapshot unusable. */ }
      }
    }));
    this.publish();
  }

  async refreshProvider(id, { force = false, signal } = {}) {
    if (!supportedPiProviderIds.includes(id)) return { provider: id, state: "unsupported" };
    await this.ready;
    signal?.throwIfAborted();
    if (this.pending.has(id)) return { provider: id, state: "busy" };
    let old = this.records.get(id);
    if (!force && old && this.now() - old.checkedAt < FRESH_MS) return { provider: id, state: "cached", count: old.currentIds.length };
    this.pending.add(id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(failure("refresh timed out; keeping the previous catalog.")), this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let release;
    try {
      // Coordinate all instances through a cache-specific lock. Re-read after
      // acquiring it, so an older process cannot erase another saved model ID.
      release = await acquirePrivateFileLock(this.file(id), { signal: combined });
      old = mergeRecords(old, await this.readRecord(id));
      if (!force && old && this.now() - old.checkedAt < FRESH_MS) {
        combined.throwIfAborted();
        this.records.set(id, old); this.publish();
        return { provider: id, state: "cached", count: old.currentIds.length };
      }
      // Pi's public metadata protocol. Deliberately independent of model credentials
      // and Models.refresh(), which can perform OAuth refresh before fetching models.
      const response = await abortable(Promise.resolve().then(() => this.fetch(
        `https://pi.dev/api/models/providers/${encodeURIComponent(id)}?pi-version=${PI_CATALOG_VERSION}`,
        { headers: { Accept: "application/json", "User-Agent": `pi/${PI_CATALOG_VERSION} (${process.platform}; ${process.arch})`,
          ...(old?.etag ? { "If-None-Match": old.etag } : {}) }, redirect: "error", credentials: "omit", signal: combined })), combined);
      let next; let skipped = 0;
      if (response.status === 304 && old) next = { ...old, checkedAt: this.now() };
      else {
        if (!response.ok) throw failure(`public metadata HTTP ${response.status}; keeping the previous catalog.`);
        const projection = projectDocument(await responseDocument(response, combined), this.baseline.getProvider(id));
        skipped = projection.skipped;
        const models = mergeKnownModels(old?.models, projection.models);
        const etag = response.headers.get("etag");
        next = { version: 1, piVersion: PI_CATALOG_VERSION, provider: id, checkedAt: this.now(),
          models, currentIds: projection.models.map(model => model.id),
          ...(printable(etag, 300) ? { etag } : {}) };
      }
      combined.throwIfAborted();
      await writeCache(this.root, this.file(id), next, combined);
      combined.throwIfAborted();
      this.records.set(id, next); this.publish();
      return { provider: id, state: response.status === 304 ? "unchanged" : "updated", count: next.currentIds.length, skipped };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      // Never render remote response bodies, arbitrary exception text or URLs.
      return { provider: id, state: "failed", reason: controller.signal.aborted ? "timeout" : "unavailable_or_incompatible" };
    } finally {
      clearTimeout(timeout);
      try { await release?.(); } finally { this.pending.delete(id); }
    }
  }

  async refresh({ provider, ...options } = {}) {
    const ids = provider ? [provider] : [...supportedPiProviderIds];
    const results = []; let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(3, ids.length) }, async () => {
      while (cursor < ids.length) {
        options.signal?.throwIfAborted();
        const id = ids[cursor++];
        results.push(await this.refreshProvider(id, options));
      }
    }));
    return results;
  }
}

const catalogs = new Map();
export async function getPublicPiModelCatalog(environment = process.env) {
  const key = path.dirname(resolveMoondogAuthFile(environment));
  if (!catalogs.has(key)) {
    const catalog = new PublicPiModelCatalog({ environment });
    catalogs.set(key, catalog); await catalog.ready; return catalog;
  }
  const catalog = catalogs.get(key);
  await catalog.ready;
  // Another running app can persist a new selection and its catalog entry.
  // Reload public cache only; do not fetch or touch the active model object.
  await catalog.restore();
  return catalog;
}
