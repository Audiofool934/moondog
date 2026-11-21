import { clip, createWebOperations, failure, requestWebService, searchSources, webLimits, webResult } from "./web-result.mjs";

// Moondog's own web search and page reading, through the same gateway and invite code as the
// Moondog model (see gateway/). Which service searches behind the gateway is the gateway's business.
//   POST {gateway}/web/search { query, count } -> { results: [{ title, url, snippet, published_at }] }
//   POST {gateway}/web/read   { url }          -> { status: "found", title, content } | { status: "unavailable" }
const limits = Object.freeze({ queryChars: 400, results: 10, searchTimeoutMs: 20_000, readTimeoutMs: 60_000 });

// The gateway's refusals, in the listener's terms. A search counts against the same daily allowance
// as the model.
function serviceError(status, body) {
  const code = String(body?.error?.code ?? "");
  if (code === "invite_invalid" || code === "invite_revoked") return failure("web_key_rejected", "Moondog's invite code no longer works. Enter a new one in Settings > Model.");
  if (code === "beta_ended") return failure("web_service_failed", "The Moondog model's test period has ended, and its web search with it.");
  if (code === "daily_allowance_used" || code === "beta_capacity_reached") {
    return failure("web_quota_exhausted", "Today's Moondog allowance is used up, web search included. It starts again at midnight, Beijing time.");
  }
  if (status === 429) return failure("web_rate_limited", "Moondog's web search is limiting requests right now. Try again in a moment.");
  if (status === 400) return failure("web_input_invalid", "Moondog's web search did not accept the request.");
  return failure("web_service_failed", `Moondog's web search failed with HTTP ${status}. Try again in a moment.`);
}

export function createMoondogWebResearch({ baseUrl, apiKey, fetch: fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const call = (operation, body, signal, timeoutMs) => requestWebService(fetchImpl, `${baseUrl}/web/${operation}`, {
    name: "Moondog", method: "POST", signal, timeoutMs, body: JSON.stringify(body),
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
  });

  async function search(query, signal) {
    const { status, body } = await call("search", { query, count: limits.results }, signal, limits.searchTimeoutMs);
    if (status !== 200) throw serviceError(status, body);
    if (!Array.isArray(body?.results)) throw failure("web_output_invalid", "Moondog's web search returned an unreadable result.");
    const sources = searchSources(body.results);
    return webResult({ provider: "moondog", kind: "search", status: sources.length ? "found" : "not_found", sources, retrievedAt: now().toISOString() });
  }

  async function read(url, signal) {
    const { status, body } = await call("read", { url }, signal, limits.readTimeoutMs);
    if (status !== 200) throw serviceError(status, body);
    const retrievedAt = now().toISOString();
    const text = body?.status === "found" && typeof body.content === "string" ? body.content.trim() : "";
    if (!text) {
      return webResult({ provider: "moondog", kind: "read", status: "unavailable", retrievedAt,
        summary: "Moondog could not get readable text from this page. It may be down, blocked, or not a text page." });
    }
    const title = typeof body.title === "string" && body.title.trim() ? clip(body.title.trim(), 300) : url;
    return webResult({ provider: "moondog", kind: "read", status: "found", retrievedAt,
      summary: clip(text, webLimits.fullTextChars), truncated: text.length > webLimits.fullTextChars,
      sources: [{ title, url, snippet: "", published_at: null }] });
  }

  return createWebOperations({
    now, queryChars: limits.queryChars,
    unavailable: () => apiKey ? null : failure("web_key_missing", "Moondog's web search needs an invite code. Enter one in Settings > Model."),
    run: (kind, value, signal) => kind === "search" ? search(value, signal) : read(value, signal),
  });
}
