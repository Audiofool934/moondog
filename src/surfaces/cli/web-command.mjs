import { sanitizeTerminalText } from "./format-output.mjs";

function inline(value) {
  return sanitizeTerminalText(value).replace(/\s+/gu, " ").replace(/[\\`*_[\]<>]/gu, "\\$&");
}

export function formatWebSources(sources) {
  return [
    "### Public web sources (Codex)",
    "",
    ...sources.map((source) => `- [${inline(source.title)}](<${source.url.replace(/[<>]/gu, encodeURIComponent)}>)${source.published_at ? ` - source date: ${inline(source.published_at)}` : ""}${source.retrieved_at ? ` - retrieved: ${source.retrieved_at}` : ""}`),
  ].join("\n");
}

export function formatWebResearch(result) {
  return [
    `# Web ${result.kind}: ${result.status}`,
    "",
    `Retrieved: ${result.retrieved_at}${result.from_cache ? " (cached)" : ""}`,
    "Codex summary of public web evidence. Dates below are source metadata, not necessarily event dates.",
    "",
    sanitizeTerminalText(result.summary),
    "",
    "## Sources",
    "",
    ...result.sources.flatMap((source) => [
      `- [${inline(source.title)}](<${source.url.replace(/[<>]/gu, encodeURIComponent)}>)${source.published_at ? ` - source date: ${inline(source.published_at)}` : " - source date unavailable"}`,
      `  ${inline(source.snippet)}`,
    ]),
  ].join("\n");
}

export async function runWebCommand({ args = [], webResearch, json = false, signal } = {}) {
  const [action = "help", ...values] = args;
  if (action === "help" || action === "--help") {
    return "# Moondog public web\n\n- `/web status` - inspect Codex CLI readiness without a model request\n- `/web search <query>` - search reviews, news, interviews or concert information\n- `/web read <https://public-page>` - read and summarize a public page\n\nThese commands use your existing Codex login and usage allowance. Results stay in the TUI. A 5-minute process-local cache avoids repeat requests. Ctrl+C cancels a request. No music-profile import is needed.\n\nShell equivalents: `moondog web status|search|read [arguments] [--json]`.";
  }
  if (!webResearch) throw new Error("Codex web research is unavailable.");
  if (action === "status" && values.length === 0) {
    const status = webResearch.publicStatus();
    return json ? JSON.stringify(status, null, 2) : `Codex web research: ${status.state}${status.reason ? ` (${status.reason})` : ""}. This readiness check made no live search request.`;
  }
  if (action === "search" && values.length > 0) {
    const result = await webResearch.search({ query: values.join(" ") }, { signal });
    return json ? JSON.stringify(result, null, 2) : formatWebResearch(result);
  }
  if (action === "read" && values.length === 1) {
    const result = await webResearch.read({ url: values[0] }, { signal });
    return json ? JSON.stringify(result, null, 2) : formatWebResearch(result);
  }
  throw new Error("Usage: /web status | /web search <query> | /web read <public-url>.");
}
