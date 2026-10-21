import { createWebOperations, failure, requestWebService, searchSources, webResult } from "./web-result.mjs";

// Brave Search's own index. It searches only; reading a page needs another backend.
// https://brave.com/search/api/ - $5 per 1,000 requests, with a free monthly credit.
// Its terms allow only transient storage of results, which the five-minute in-memory cache is.
const endpoint = "https://api.search.brave.com/res/v1/web/search";
const limits = Object.freeze({ queryChars: 400, results: 10, timeoutMs: 15_000 });

function serviceError(status, body) {
  const code = String(body?.error?.code ?? "");
  if (status === 401 || status === 403) return failure("web_key_rejected", "Brave Search rejected the API key. Run /auth brave to replace it.");
  if (status === 402 || (status === 429 && /quota/iu.test(code))) {
    return failure("web_quota_exhausted", "The Brave Search credit for this month is used up. Check the plan at api-dashboard.search.brave.com.");
  }
  if (status === 429) return failure("web_rate_limited", "Brave Search is limiting requests right now. Try again in a moment.");
  if (status === 400 || status === 422) return failure("web_input_invalid", "Brave Search did not accept the query.");
  return failure("web_service_failed", `Brave Search failed with HTTP ${status}. Try again in a moment.`);
}

export function createBraveWebResearch({ apiKey, fetch: fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  async function search(query, signal) {
    const url = new URL(endpoint);
    url.search = new URLSearchParams({ q: query, count: String(limits.results), extra_snippets: "true" }).toString();
    const { status, body } = await requestWebService(fetchImpl, url, {
      name: "Brave Search", signal, timeoutMs: limits.timeoutMs,
      headers: { accept: "application/json", "x-subscription-token": apiKey },
    });
    if (status !== 200) throw serviceError(status, body);
    const results = body?.web?.results ?? [];
    if (!Array.isArray(results)) throw failure("web_output_invalid", "Brave Search returned an unreadable result.");
    // Extra snippets are further passages from the same page; together they tell the agent more than the description.
    const sources = searchSources(results.map((item) => ({
      title: item?.title, url: item?.url, published_at: item?.page_age ?? item?.age ?? null,
      snippet: [item?.description, ...(Array.isArray(item?.extra_snippets) ? item.extra_snippets : [])].filter((text) => typeof text === "string").join(" … "),
    })));
    return webResult({ provider: "brave", kind: "search", status: sources.length ? "found" : "not_found", sources, retrievedAt: now().toISOString() });
  }

  return createWebOperations({
    now, queryChars: limits.queryChars,
    unavailable: (kind) => kind === "read" ? failure("web_read_unsupported", "Brave Search only searches. Reading a page needs DeepSeek or the Codex CLI.")
      : apiKey ? null : failure("web_key_missing", "Brave Search needs an API key. Run /auth brave."),
    run: (_kind, value, signal) => search(value, signal),
  });
}
