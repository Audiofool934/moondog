import { clip, createWebOperations, failure, requestWebService, searchSources, webLimits, webResult } from "./web-result.mjs";

// DeepSeek's Search and Fetch tools, on the same API key as its models.
// https://api-docs.deepseek.com/guides/search/ - $0.75 per 1,000 successful requests each.
const endpoint = "https://api.deepseek.com/v1/tools";
const limits = Object.freeze({ queryChars: 128, results: 10, searchTimeoutMs: 20_000, fetchTimeoutMs: 60_000 });

// Fetch escapes nearly every punctuation mark in its Markdown ("\," "\."), which only costs tokens.
function pageText(markdown) {
  return markdown
    .replace(/\\([!-/:-@[-`{-~])/gu, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

// Dates are calendar days at midnight Beijing time, so "2025-09-05T16:00:00+00:00" is a page
// published on September 6. Read as UTC, every date would be a day early.
function publishedDate(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const beijing = new Date(time + 8 * 3_600_000).toISOString();
  return beijing.endsWith("T00:00:00.000Z") ? beijing.slice(0, 10) : new Date(time).toISOString();
}

// Search titles often repeat themselves: "Title - Site - Title".
function searchTitle(title) {
  const parts = String(title ?? "").split(" - ");
  return parts.length > 1 && parts.at(-1).trim() === parts[0].trim() ? parts.slice(0, -1).join(" - ") : title;
}

function serviceError(status, body) {
  const detail = typeof body?.error?.message === "string" ? ` (${body.error.message.slice(0, 160)})` : "";
  if (status === 401) return failure("web_key_rejected", "DeepSeek rejected the API key. Run /auth deepseek to replace it.");
  if (status === 402) return failure("web_quota_exhausted", "The DeepSeek balance is too low for web lookups. Top it up at platform.deepseek.com.");
  if (status === 400) return failure("web_input_invalid", `DeepSeek did not accept the request${detail}.`);
  if (status === 429) return failure("web_rate_limited", "DeepSeek is limiting requests right now. Try again in a moment.");
  return failure("web_service_failed", `DeepSeek web lookup failed with HTTP ${status}. Try again in a moment.`);
}

export function createDeepSeekWebResearch({ apiKey, fetch: fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const call = async (tool, body, signal, timeoutMs) => requestWebService(fetchImpl, `${endpoint}/${tool}`, {
    name: "DeepSeek", method: "POST", signal, timeoutMs, body: JSON.stringify(body),
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
  });

  async function search(query, signal) {
    const { status, body } = await call("search", { query, count: limits.results }, signal, limits.searchTimeoutMs);
    if (status !== 200) throw serviceError(status, body);
    if (!Array.isArray(body?.results)) throw failure("web_output_invalid", "DeepSeek returned an unreadable search result.");
    // The summary is DeepSeek's longer text written for models; the snippet is for display.
    const sources = searchSources(body.results.map((item) => ({
      title: searchTitle(item?.title), url: item?.url, published_at: publishedDate(item?.date),
      snippet: typeof item?.summary === "string" && item.summary.trim() ? pageText(item.summary).replace(/^#{1,6}\s+/gmu, "") : item?.snippet,
    })));
    return webResult({ provider: "deepseek", kind: "search", status: sources.length ? "found" : "not_found", sources, retrievedAt: now().toISOString() });
  }

  async function read(url, signal) {
    const { status, body } = await call("fetch", { url }, signal, limits.fetchTimeoutMs);
    const retrievedAt = now().toISOString();
    // 403 is DeepSeek's security policy and 404 a page without usable text; both are answers, not faults.
    const text = status === 200 && typeof body?.content === "string" ? pageText(body.content) : "";
    if (status === 403 || status === 404 || (status === 200 && !text)) {
      return webResult({ provider: "deepseek", kind: "read", status: "unavailable", retrievedAt,
        summary: status === 403 ? "DeepSeek declined to fetch this page under its security policy."
          : "DeepSeek could not get readable text from this page. It may be down, blocked, or not a text page." });
    }
    if (status !== 200) throw serviceError(status, body);
    const title = typeof body.title === "string" && body.title.trim() ? clip(body.title.trim(), 300) : url;
    return webResult({ provider: "deepseek", kind: "read", status: "found", retrievedAt,
      summary: clip(text, webLimits.textChars), truncated: text.length > webLimits.textChars,
      sources: [{ title, url, snippet: "", published_at: null }] });
  }

  return createWebOperations({
    now, queryChars: limits.queryChars,
    unavailable: () => apiKey ? null : failure("web_key_missing", "DeepSeek web lookups need a DeepSeek API key. Run /auth deepseek."),
    run: (kind, value, signal) => kind === "search" ? search(value, signal) : read(value, signal),
  });
}
