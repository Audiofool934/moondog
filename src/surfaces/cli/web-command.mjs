import { translator } from "../../i18n/index.mjs";
import { webProviderName } from "../../integrations/web/web-result.mjs";
import { webSetupText } from "../../integrations/web/web-research.mjs";
import { sanitizeTerminalText } from "./format-output.mjs";

function inline(value) {
  return sanitizeTerminalText(value).replace(/\s+/gu, " ").replace(/[\\`*_[\]<>]/gu, "\\$&");
}

function link(source) {
  return `[${inline(source.title)}](<${source.url.replace(/[<>]/gu, encodeURIComponent)}>)`;
}

/** The sources under an agent reply, in the reply's language, naming the services that found them. */
export function formatWebSources(sources, t = translator("en")) {
  const providers = [...new Set(sources.map((source) => webProviderName(source.provider)).filter(Boolean))];
  return [
    `### ${providers.length ? t("web.sources.heading", { providers: providers.join(", ") }) : t("web.sources.headingUnnamed")}`,
    "",
    ...sources.map((source) => [
      `- ${link(source)}`,
      ...(source.published_at ? [t("web.sources.published", { date: inline(source.published_at) })] : []),
      ...(source.retrieved_at ? [t("web.sources.retrieved", { date: source.retrieved_at.slice(0, 10) })] : []),
    ].join(" - ")),
  ].join("\n");
}

const contentNotes = {
  model_generated_web_summary: () => "A Codex summary of public pages. The dates are when each page was published, which may not be when things happened.",
  search_engine_results: (name) => `Search results from ${name}, as the search engine gives them. The dates are when each page was published, which may not be when things happened.`,
  fetched_page_text: (name, result) => `The page's own text, fetched by ${name}${result.truncated ? " and cut short" : ""}.`,
};

export function formatWebResearch(result) {
  const name = webProviderName(result.provider) ?? "the web service";
  const snippet = (text) => text.length > 320 ? `${text.slice(0, 319).trimEnd()}…` : text;
  return [
    `# Web ${result.kind}: ${result.status.replaceAll("_", " ")}`,
    "",
    `Retrieved: ${result.retrieved_at}${result.from_cache ? " (cached)" : ""}`,
    contentNotes[result.content_kind]?.(name, result) ?? `From ${name}.`,
    ...(result.summary ? ["", sanitizeTerminalText(result.summary)] : []),
    ...(result.sources.length ? ["", "## Sources", ""] : []),
    ...result.sources.flatMap((source) => [
      `- ${link(source)}${source.published_at ? ` - source date: ${inline(source.published_at)}` : " - source date unavailable"}`,
      ...(source.snippet ? [`  ${inline(snippet(source.snippet))}`] : []),
    ]),
  ].join("\n");
}

function formatStatus(status) {
  const line = (label, entry) => {
    const name = webProviderName(entry.provider);
    if (entry.state === "configured") {
      return `- ${label}: ${name}${entry.credential ? `, with the key from ${entry.credential === "stored credential" ? "/auth" : entry.credential}` : ""}${entry.selected_by ? `, chosen by ${entry.selected_by}` : ""}`;
    }
    const reason = entry.requested ? `${entry.requested} is not a web backend` : entry.reason?.replaceAll("_", " ") ?? "not set up";
    return `- ${label}: not set up${name ? ` (${name}: ${reason})` : ` (${reason})`}`;
  };
  return [
    "# Web lookups",
    "",
    // A single backend reports one status for both.
    line("Search", status.search ?? status),
    line("Page reading", status.read ?? status),
    "",
    ...(status.state === "configured" ? [] : ["To set one up:", "", webSetupText, "", "From the shell, `moondog auth login deepseek` or `moondog auth login brave` does the same.", ""]),
    "Checking this didn't search anything.",
  ].join("\n");
}

export async function runWebCommand({ args = [], webResearch, json = false, signal } = {}) {
  const [action = "help", ...values] = args;
  if (action === "help" || action === "--help") {
    return `# Moondog public web\n\n- \`/web status\` - see which service searches and reads pages, without a request\n- \`/web search <query>\` - search reviews, news, interviews or concert information\n- \`/web read <https://public-page>\` - read a public page\n\nSearch uses DeepSeek when \`/auth deepseek\` has a key, then Brave Search with \`/auth brave\`, then your signed-in Codex CLI. Reading uses DeepSeek, then Codex. \`MOONDOG_WEB_SEARCH_PROVIDER\` and \`MOONDOG_WEB_READ_PROVIDER\` (deepseek, brave or codex) choose one.\n\nResults stay in the TUI. A 5-minute process-local cache avoids repeat requests. Ctrl+C cancels a request. No music-profile import is needed.\n\nShell equivalents: \`moondog web status|search|read [arguments] [--json]\`.`;
  }
  if (!webResearch) throw new Error("Web lookups aren't available right now.");
  if (action === "status" && values.length === 0) {
    const status = webResearch.publicStatus();
    return json ? JSON.stringify(status, null, 2) : formatStatus(status);
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
