import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { acquirePrivateFileLock, resolveMoondogAuthFile } from "./persistent-credential-store.mjs";

export const CUSTOM_PROVIDER = "custom-endpoint";
const protocols = { "openai-completions": openAICompletionsApi, "openai-responses": openAIResponsesApi, "anthropic-messages": anthropicMessagesApi };
const error = (message) => Object.assign(new Error(message), { code: "custom_endpoint_invalid" });
export function normalizeEndpoint(value) {
  let url;
  try { url = new URL(String(value ?? "").trim()); } catch { throw error("请输入有效的 API 地址。 / Enter a valid API base URL."); }
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw error("API 地址需要 HTTPS，本机 localhost 可使用 HTTP；请勿在地址中填写密钥。 / Use HTTPS (HTTP is allowed for localhost), without URL credentials or query parameters.");
  }
  // Accept either the API base URL or a copied operation URL.
  url.pathname = url.pathname.replace(/\/(?:chat\/completions|responses|messages)\/?$/u, "").replace(/\/+$/u, "");
  return url.href.replace(/\/$/u, "");
}
const fileFor = (environment) => path.join(path.dirname(resolveMoondogAuthFile(environment)), "custom-endpoint.json");
function validate(value) {
  let baseUrl = normalizeEndpoint(value.baseUrl);
  const modelId = String(value.modelId ?? "").trim();
  const protocol = value.protocol ?? "openai-completions";
  if (protocol === "anthropic-messages") baseUrl = baseUrl.replace(/\/v1$/u, "");
  const apiKey = String(value.apiKey ?? "").trim();
  const contextWindow = Number(value.contextWindow ?? 128000);
  const maxTokens = Number(value.maxTokens ?? 4096);
  if (!modelId || modelId.length > 200 || /[\p{C}\s]/u.test(modelId)) throw error("请输入中转站提供的模型 ID。 / Enter the gateway's model ID.");
  if (!Object.hasOwn(protocols, protocol)) throw error("不支持的 API 协议。 / Unsupported API protocol.");
  if (!apiKey || apiKey.length > 8192 || /[\p{C}\s]/u.test(apiKey)) throw error("请填写 API Key。 / Enter an API key.");
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024 || contextWindow > 10_000_000 ||
    !Number.isSafeInteger(maxTokens) || maxTokens < 16 || maxTokens > contextWindow) throw error("上下文和输出 token 数无效。 / Invalid context/output token limits.");
  return { baseUrl, modelId, protocol, apiKey, contextWindow, maxTokens };
}
export async function readCustomEndpoint(environment = process.env) {
  try {
    const data = JSON.parse(await readFile(fileFor(environment), "utf8"));
    if (data.version !== 1) throw error("Unsupported custom endpoint version.");
    return validate(data);
  } catch (cause) {
    if (cause.code === "ENOENT") return null;
    throw error("自定义接口配置无法读取，请重新保存。 / Could not read the custom endpoint. Save it again.");
  }
}
export function publicCustomEndpoint(config) {
  if (!config) return { configured: false };
  const { apiKey, ...publicFields } = config;
  return { configured: true, ...publicFields, keySaved: Boolean(apiKey) };
}
export async function writeCustomEndpoint(input, environment = process.env) {
  const file = fileFor(environment);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const release = await acquirePrivateFileLock(file);
  try {
    const previous = await readCustomEndpoint(environment).catch(() => null);
    let baseUrl = normalizeEndpoint(input.baseUrl);
    if (input.protocol === "anthropic-messages") baseUrl = baseUrl.replace(/\/v1$/u, "");
    // Never silently forward a saved key to a newly entered endpoint.
    const config = validate({ ...input, baseUrl, apiKey: input.apiKey?.trim() || (previous?.baseUrl === baseUrl ? previous.apiKey : "") });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, ...config }), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
    return publicCustomEndpoint(config);
  } finally { await release(); }
}
export async function removeCustomEndpoint(environment = process.env) {
  const file = fileFor(environment);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const release = await acquirePrivateFileLock(file);
  try { await rm(file, { force: true }); } finally { await release(); }
}
export function addCustomEndpoint(models, config) {
  if (!config) return models;
  const model = { id: config.modelId, name: config.modelId, provider: CUSTOM_PROVIDER, api: config.protocol, baseUrl: config.baseUrl,
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow, maxTokens: config.maxTokens,
    ...(config.protocol === "openai-completions" ? { compat: { supportsStore: false, supportsDeveloperRole: false,
      supportsReasoningEffort: false, supportsUsageInStreaming: false, maxTokensField: "max_tokens" } } : {}) };
  models.setProvider(createProvider({ id: CUSTOM_PROVIDER, name: "自定义 API / Custom API", baseUrl: config.baseUrl,
    models: [model], auth: { apiKey: { name: "Custom API key", resolve: async () => ({ auth: { apiKey: config.apiKey }, source: "stored credential" }) } },
    api: protocols[config.protocol]() }));
  return models;
}
export async function testCustomEndpoint(config, { signal, fetchImpl = globalThis.fetch } = {}) {
  const { createModels } = await import("@earendil-works/pi-ai");
  const models = addCustomEndpoint(createModels(), config);
  try {
    const result = await models.completeSimple(models.getModel(CUSTOM_PROVIDER, config.modelId), {
      messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }],
    }, { maxTokens: 16, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      fetch: (url, options) => fetchImpl(url, { ...options, redirect: "error" }), maxRetries: 0 });
    if (result.stopReason === "error" || !result.content?.some((item) => item.type === "text" && item.text)) throw new Error();
    return { ok: true };
  } catch {
    if (signal?.aborted) throw signal.reason;
    throw Object.assign(new Error("连接测试失败，请检查地址、API Key、协议和模型 ID。 / Connection failed. Check the URL, key, protocol and model ID."), { code: "custom_endpoint_test_failed" });
  }
}
