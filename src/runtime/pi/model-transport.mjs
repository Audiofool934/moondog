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
    "openai-codex": "OpenAI Codex", openai: "OpenAI", anthropic: "Anthropic",
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

async function retryDelay(milliseconds, signal) {
  await delay(milliseconds, undefined, { signal });
}

/** Recover only rejected model HTTP fetches, before a Response or stream exists. */
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
    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted();
      try {
        // Status codes and response-body errors remain Pi's responsibility.
        return await fetchImpl(input, init);
      } catch (cause) {
        if (signal?.aborted || cause?.name === "AbortError") throw cause;
        const failure = connectionFailure(cause);
        if (!failure) throw cause;
        if (canReplay && failure.retryable && attempt < maximumRetries) {
          onRetry?.({ attempt: attempt + 1, maxRetries: maximumRetries });
          await wait(250 * 2 ** attempt, signal);
          continue;
        }
        const error = createModelConnectionError({ provider, cause });
        onFailure?.(error);
        throw error;
      }
    }
  };
}
