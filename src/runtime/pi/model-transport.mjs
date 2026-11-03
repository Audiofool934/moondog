import { setTimeout as delay } from "node:timers/promises";

const maximumRetries = 2;
const retryableCodes = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN",
  "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
]);
const certificateCodes = new Set([
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID",
]);
const invalidRequestCodes = new Set([
  "ERR_INVALID_URL", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE",
  "ERR_INVALID_STATE", "ERR_HTTP_INVALID_HEADER_VALUE", "ERR_INVALID_HTTP_TOKEN",
  "UND_ERR_INVALID_ARG",
]);
const publicCodes = new Set([...retryableCodes, ...certificateCodes]);
const publicCodePattern = new RegExp(`\\b(${[...publicCodes].join("|")})\\b`, "u");
const connectionMessagePattern = /^(?:fetch failed|failed to fetch|network (?:error|request failed)|connection error)\.?$|\b(?:socket hang up|other side closed|connection (?:reset|refused|lost)|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|(?:connect|connection|response headers|request) timed? out|websocket (?:closed|error))\b|^terminated$/iu;
const credentialMessagePattern = /(?:access|refresh|id)[_ -]?token|api[_ -]?key|authentication|unauthorized|forbidden|quota|billing/iu;
const credentialBearingErrorPattern = /(?:access|refresh|id)[_ -]?token|api[_ -]?key|authorization\s*[:=]\s*bearer|oauth\s+(?:auth|refresh|token)|credential\s+store/iu;

export function safeProviderErrorMessage(value, provider) {
  const message = typeof value === "string" && value.trim()
    ? value.trim() : "The model provider request failed.";
  if (credentialBearingErrorPattern.test(message)) {
    return `${provider === "openai" ? "OpenAI" : provider} authentication failed. Run moondog auth login ${provider}${provider === "openai" ? " --chatgpt, or with an API key," : ""} and try again.`;
  }
  return message;
}

function errorChain(value) {
  const pending = [value];
  const seen = new Set();
  const values = [];
  while (pending.length && values.length < 8) {
    const current = pending.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    values.push(current);
    if (current.cause) pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors.slice(0, 8));
  }
  return values;
}

function connectionFailure(value) {
  const chain = errorChain(value);
  if (chain.some((error) => invalidRequestCodes.has(error.code) ||
    Number.isInteger(error.status) || Number.isInteger(error.statusCode) ||
    error.name === "AbortError")) return null;
  const messages = chain.map((error) => typeof error === "string" ? error : error.message ?? "");
  if (messages.some((message) => credentialMessagePattern.test(message))) return null;
  const code = chain.map((error) => error.code).find((candidate) => publicCodes.has(candidate)) ??
    messages.map((message) => message.match(publicCodePattern)?.[1]).find(Boolean);
  if (code) return { code, retryable: retryableCodes.has(code) };
  return messages.some((message) => connectionMessagePattern.test(message))
    ? { code: undefined, retryable: true }
    : null;
}

export function isModelConnectionFailure(value) {
  return connectionFailure(value) !== null;
}

export function createModelConnectionError({ provider, cause, toolsExecuted = false }) {
  const label = ({
    openai: "OpenAI", anthropic: "Anthropic",
    deepseek: "DeepSeek", moonshotai: "Moonshot AI", "moonshotai-cn": "Moonshot AI China",
    xai: "xAI", zai: "Z.AI",
  })[provider] ?? (/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(provider ?? "") ? provider : "The model provider");
  const code = connectionFailure(cause)?.code;
  const error = new Error(
    `${label} could not complete the model request${code ? ` (${code})` : ""}. Check your connection or proxy settings.`,
    { cause },
  );
  error.code = "model_connection_failed";
  error.toolsExecuted = toolsExecuted === true;
  return error;
}

function replayableBody(input, init) {
  // JSON strings and Codex's compressed buffers can be sent again unchanged.
  // A caller-owned Request body or stream may already be consumed after failure.
  if (input instanceof Request && input.body !== null) return false;
  const body = init?.body;
  return body == null || typeof body === "string" || body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) || body instanceof URLSearchParams || body instanceof Blob;
}

// Statuses that say the provider is busy right now, not that the request is wrong.
const overloadStatuses = new Set([502, 503, 504, 529]);
const maximumOverloadRetries = 3;

// How long to wait before sending an overloaded request again, or null to return the response.
// A 429 is retried only when the provider asks for a short wait; a long one is usually a quota.
function overloadRetryDelay(response, retries) {
  if (!response || typeof response.status !== "number") return null;
  const value = response.headers?.get?.("retry-after");
  const header = value === null || value === undefined || value === "" ? NaN : Number(value);
  const asked = Number.isFinite(header) && header >= 0 ? header * 1000 : null;
  if (response.status === 429) return asked !== null && asked <= 10_000 ? asked : null;
  if (!overloadStatuses.has(response.status)) return null;
  return Math.min(asked ?? 1000 * 2 ** retries, 10_000);
}

async function retryDelay(milliseconds, signal) {
  await delay(milliseconds, undefined, { signal });
}

/** Recover rejected model HTTP fetches, and overloaded answers, before a stream exists. */
export function createModelFetch({
  provider,
  fetchImpl = globalThis.fetch,
  wait = retryDelay,
  onRetry,
  onFailure,
} = {}) {
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const canReplay = replayableBody(input, init);
    // Connection failures and overloaded answers each have their own small budget.
    let overloadAttempts = 0;
    let attempt = 0;
    for (;;) {
      signal?.throwIfAborted();
      try {
        const response = await fetchImpl(input, init);
        // A provider that is overloaded answers before it produces anything, so the same request
        // is sent again after a short wait. Other status codes and body errors stay Pi's.
        const retryAfter = overloadRetryDelay(response, overloadAttempts);
        if (canReplay && retryAfter !== null && overloadAttempts < maximumOverloadRetries) {
          overloadAttempts += 1;
          await response.body?.cancel().catch(() => {});
          onRetry?.({ attempt: overloadAttempts, maxRetries: maximumOverloadRetries, status: response.status });
          await wait(retryAfter, signal);
          continue;
        }
        return response;
      } catch (cause) {
        if (signal?.aborted || cause?.name === "AbortError") throw cause;
        const failure = connectionFailure(cause);
        if (!failure) throw cause;
        if (canReplay && failure.retryable && attempt < maximumRetries) {
          onRetry?.({ attempt: attempt + 1, maxRetries: maximumRetries });
          await wait(250 * 2 ** attempt, signal);
          attempt += 1;
          continue;
        }
        const error = createModelConnectionError({ provider, cause });
        onFailure?.(error);
        throw error;
      }
    }
  };
}
