import { isIP } from "node:net";

import Ajv from "ajv";

// Every web backend returns this one result shape, checked by the same rules,
// so the agent and the screen never need to know which service answered.
export const webLimits = Object.freeze({
  sources: 5, snippetChars: 800, textChars: 12_000, cacheMs: 300_000, cacheEntries: 32, responseBytes: 2_000_000,
});

// What each backend's text is, so the agent can tell a search engine's snippet from a model's summary.
const backends = Object.freeze({
  codex_cli: { name: "Codex CLI", evidence: "native_web_operation_observed", content: { search: "model_generated_web_summary", read: "model_generated_web_summary" } },
  deepseek: { name: "DeepSeek", evidence: "provider_api_response", content: { search: "search_engine_results", read: "fetched_page_text" } },
  brave: { name: "Brave Search", evidence: "provider_api_response", content: { search: "search_engine_results" } },
});

export function webProviderName(provider) {
  return backends[provider]?.name ?? null;
}

const resultSchema = {
  type: "object", additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["found", "not_found", "unavailable"] },
    summary: { type: "string", maxLength: webLimits.textChars },
    sources: {
      type: "array", maxItems: webLimits.sources,
      items: {
        type: "object", additionalProperties: false,
        properties: {
          title: { type: "string", minLength: 1, maxLength: 300 },
          url: { type: "string", minLength: 1, maxLength: 2048 },
          snippet: { type: "string", maxLength: 1500 },
          published_at: { type: ["string", "null"], maxLength: 100 },
        },
        required: ["title", "url", "snippet", "published_at"],
      },
    },
  },
  required: ["status", "summary", "sources"],
};
const validate = new Ajv({ strict: false }).compile(resultSchema);

export function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

export function cleanText(value) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu, "").trim();
}

// Search engines mark matches with HTML; the agent and the screen want plain words.
export function plainText(value) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return String(value ?? "")
    .replace(/<[^>]*>/gu, "")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (match, name) => name[0] !== "#" ? entities[name.toLowerCase()] ?? match
      : String.fromCodePoint(Number.parseInt(name.slice(name[1].toLowerCase() === "x" ? 2 : 1), name[1].toLowerCase() === "x" ? 16 : 10) || 0xfffd))
    .replace(/\s+/gu, " ").trim();
}

export function clip(value, limit) {
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;
}

export function publicWebUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw failure("web_url_invalid", "Supply a complete public http:// or https:// URL."); }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!new Set(["https:", "http:"]).has(url.protocol) || url.username || url.password || url.port ||
      isIP(hostname) || !hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/u.test(hostname)) {
    throw failure("web_url_invalid", "Only public web pages without credentials, IP literals, or custom ports are supported.");
  }
  url.hash = "";
  return url.href;
}

function projectSources(sources) {
  return sources.map((source) => ({
    title: cleanText(source.title), url: publicWebUrl(source.url),
    snippet: cleanText(source.snippet), published_at: source.published_at === null ? null : cleanText(source.published_at),
  }));
}

/** A backend's result in the shared shape, before any caller sees it. */
export function webResult({ provider, kind, status, summary = "", sources = [], retrievedAt, truncated = false }) {
  const backend = backends[provider];
  if (!validate({ status, summary, sources }) || (status === "found" && !sources.length) || !backend?.content[kind]) {
    throw failure("web_output_invalid", `${backend?.name ?? "The web service"} returned an invalid or unsourced research result.`);
  }
  return {
    provider, kind, status, retrieved_at: retrievedAt, from_cache: false,
    content_kind: backend.content[kind], trust: "untrusted_web_content", evidence: backend.evidence,
    ...(truncated ? { truncated: true } : {}),
    summary: cleanText(summary), sources: projectSources(sources),
  };
}

/** What the agent sees: only the shared fields, rechecked, whatever the backend added. */
export function projectWebResearchResult(value) {
  const payload = { status: value?.status, summary: value?.summary, sources: value?.sources };
  const backend = backends[value?.provider];
  if (!validate(payload) || (payload.status === "found" && !payload.sources.length) ||
      !backend?.content[value.kind] || value.evidence !== backend.evidence || !Number.isFinite(Date.parse(value.retrieved_at))) {
    throw failure("web_output_invalid", `${backend?.name ?? "The web service"} returned an invalid or unsourced research result.`);
  }
  return {
    provider: value.provider, kind: value.kind, status: payload.status,
    retrieved_at: new Date(value.retrieved_at).toISOString(), from_cache: value.from_cache === true,
    content_kind: backend.content[value.kind], trust: "untrusted_web_content", evidence: backend.evidence,
    ...(value.truncated === true ? { truncated: true } : {}),
    summary: cleanText(payload.summary), sources: projectSources(payload.sources),
  };
}

/**
 * Raw search results in the shared shape: public URLs only, one entry per page,
 * and no more than the agent's source limit. Engines repeat a page under small variations.
 */
export function searchSources(items) {
  const sources = [];
  const seen = new Set();
  for (const item of items) {
    let url;
    try { url = publicWebUrl(item.url); } catch { continue; }
    const title = clip(cleanText(plainText(item.title)), 300);
    const snippet = clip(cleanText(plainText(item.snippet)), webLimits.snippetChars);
    if (!title || seen.has(url) || (snippet && seen.has(snippet))) continue;
    seen.add(url);
    if (snippet) seen.add(snippet);
    const date = typeof item.published_at === "string" ? cleanText(item.published_at).slice(0, 100) : "";
    sources.push({ title, url, snippet, published_at: date || null });
    if (sources.length === webLimits.sources) break;
  }
  return sources;
}

/**
 * The parts every backend shares: one query or URL in, a cancellable request,
 * and a five-minute process-local cache of found results.
 */
export function createWebOperations({ unavailable = () => null, queryChars = 500, run, now = () => new Date() }) {
  const cache = new Map();
  const active = new Set();
  async function research(kind, input, { signal } = {}) {
    const blocked = unavailable(kind);
    if (blocked) throw blocked;
    if (!input || typeof input !== "object" || Object.keys(input).some((key) => key !== (kind === "search" ? "query" : "url"))) {
      throw failure("web_input_invalid", "Supply one search query or public URL.");
    }
    const value = kind === "read" ? publicWebUrl(input.url) : typeof input.query === "string" ? input.query.trim() : input.query;
    if (typeof value !== "string" || !value) throw failure("web_input_invalid", "The web query or URL is empty.");
    if (value.length > (kind === "search" ? queryChars : 2048)) {
      throw failure("web_input_invalid", kind === "search" ? `Keep the search under ${queryChars} characters.` : "The URL is too long.");
    }
    if (signal?.aborted) throw failure("web_cancelled", "Web research cancelled.");
    const key = `${kind}:${value}`;
    const cached = cache.get(key);
    if (cached && now().getTime() - Date.parse(cached.retrieved_at) < webLimits.cacheMs) {
      return { ...structuredClone(cached), from_cache: true };
    }
    const controller = new AbortController();
    active.add(controller);
    try {
      const result = await run(kind, value, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
      if (result.status === "found") {
        cache.set(key, result);
        if (cache.size > webLimits.cacheEntries) cache.delete(cache.keys().next().value);
      }
      return structuredClone(result);
    } finally {
      active.delete(controller);
    }
  }
  return {
    search: (input, options) => research("search", input, options),
    read: (input, options) => research("read", input, options),
    close() { for (const controller of active) controller.abort(); cache.clear(); },
  };
}

async function boundedText(response, limit) {
  if (Number(response.headers.get("content-length")) > limit) throw failure("web_output_limit", "The web service sent more than the bounded result limit.");
  if (!response.body) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw failure("web_output_limit", "The web service sent more than the bounded result limit.");
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/** One bounded HTTPS request to a web search service; the body is parsed JSON, or null. */
export async function requestWebService(fetchImpl, url, { name, signal, timeoutMs, ...init }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  let text;
  try {
    response = await fetchImpl(url, { ...init, redirect: "error", signal: combined });
    text = await boundedText(response, webLimits.responseBytes);
  } catch (error) {
    if (signal?.aborted) throw failure("web_cancelled", "Web research cancelled.");
    if (timeout.aborted) throw failure("web_timeout", `${name} did not answer in time. Try again, or narrow the query.`);
    if (error?.code === "web_output_limit") throw error;
    throw failure("web_service_unreachable", `${name} could not be reached. Check the connection and try again.`);
  }
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, headers: response.headers, body };
}
